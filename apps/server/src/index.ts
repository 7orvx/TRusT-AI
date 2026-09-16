import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { generateAIDecision, MarketTrigger, AIDecision } from './aiProvider.js';
import { getUniswapSwapData, UniswapSwapData } from './uniswapApi.js';
import { getLivePairPrice } from './poolPrice.js';

// Load .env. Two locations are tried (first hit wins per key, dotenv does
// not override existing vars):
//   1. <dir of the running executable>/.env — the desktop shell spawns the
//      SEA exe from the active Cargo target dir and stage-sidecars.mjs drops a
//      fresh copy of the monorepo root .env there. Without this, desktop runs
//      silently fell back to defaults (NETWORK_NAME=sepolia etc.) because
//      process.cwd() there is the target dir and '../../.env' resolved nowhere.
//   2. <cwd>/../../.env — the monorepo root, for `npm run dev:server`.
dotenv.config({ path: path.resolve(path.dirname(process.execPath), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.SERVER_PORT || 3001;
// Host the orchestrator binds to. Default 0.0.0.0 keeps the documented LAN-dev
// behavior; the desktop shell spawns this server with SERVER_BIND=127.0.0.1 so
// the packaged app is only reachable from the user's own machine.
const BIND_HOST = process.env.SERVER_BIND || '0.0.0.0';

app.use(cors());
app.use(express.json());

// Serve the built dashboard (optional). In the Tauri desktop shell the
// dashboard is embedded in the WebView, but serving it from the orchestrator
// also lets users open http://localhost:3001 in any browser (and eases
// debugging). Skipped when the build output is absent (e.g. `npm run dev`).
const webDist = process.env.TRUST_AI_WEB_DIST || path.resolve(process.cwd(), '../../apps/web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback: unmatched GET (non-/api) renders the dashboard.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`🖥️  Serving dashboard from ${webDist}`);
}

// In-memory system state
let currentProvider = process.env.LLM_PROVIDER || 'mock';
let currentApiKey = '';
let emergencyPause = false;
let maxSlippageBps = Number(process.env.DEFAULT_SLIPPAGE_BPS) || 50;
// Per-signal trade budget, denominated in the BASE token of the monitored pair
// (WETH for WETH/USDC, WBTC for WBTC/USDC — the dashboard stores one cap per
// token symbol and pushes the active one here). Every AI decision (mock or
// real LLM) is clamped to this cap server-side; the dashboard additionally
// refuses to execute a signal above the cap.
let maxTradeAmountEth = Number(process.env.MAX_TRADE_AMOUNT_ETH) || 0.25;

// Base symbol of the pair used as the budget unit — only for prompt/log
// wording (the clamp itself is a plain number). "ALL" monitor mode falls back
// to WETH, the base of the default pairs.
function pairBaseSymbol(pair: string): string {
  return pair && pair !== 'ALL' && pair.includes('/') ? pair.split('/')[0] : 'WETH';
}
let selectedPair = 'ALL';
let analysisIntervalMs = 15000; // Throttle: minimum interval between AI analyses (ms)
let lastAnalysisTime = 0;

// RPC link configured through the dashboard plug-in (API Keys modal). The Rust
// engine pulls it via GET /api/rpc-config at startup, so the user never needs
// to edit .env. The URL embeds the provider key — only served over this
// endpoint, never broadcast over WebSocket. Live data consumption is Phase 4.
export let rpcConfig: { configured: boolean; provider: string; url: string; network: string } = {
  configured: false,
  provider: '',
  url: '',
  network: process.env.NETWORK_NAME || 'sepolia'
};

// Route selection state (Uniswap v4 route — see
// docs/design/uniswap-routing-v3-v4-hooks.md). uniswapApi.ts imports this same
// object to read the PoolKey params for the calldata encoder. The legacy v3
// leg was removed (v4-only product direction, 2026-09-15). The dashboard
// pushes these via /api/settings (Route panel); the engine is untouched — it
// streams the same pair triggers, and the active route shapes only the swap
// card/calldata.
export let routeConfig = {
  protocol: 'v4' as const,
  // v4 PoolKey params: MUST match the deployed pool's PoolKey or the swap
  // reverts. User's Unichain Sepolia v4 pool (created via the v4 PositionManager
  // 0xf969Aee6…, tx 0xae5f9cb3…): poolId 0xa57deccfba1974a0e6ee9a2eebe6e883
  // 093326743288e2784610715bf7e62752, fee 2500 (0.25%), tickSpacing 25, no hook.
  v4Fee: 2500,
  v4TickSpacing: 25,
  v4HooksAddress: '',
  // Human-readable summary of getHookPermissions flags the dashboard read for
  // v4HooksAddress (e.g. "beforeSwap=1 afterSwap=1"). Fed to the LLM prompt so
  // the agent can factor hook semantics into its decision.
  v4HookPermissions: ''
};

// Active WebSocket connections (React dashboard clients)
const clients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
  console.log('⚡ [WebSocket Server] Dashboard client connected!');
  clients.add(ws);

  // Send the initial system state. The dashboard needs the active provider and
  // selected pair so it can start the right pipeline immediately.
  console.log(`🔌 [WS] SYSTEM_INIT → provider=${currentProvider} selectedPair=${selectedPair} intervalSec=${Math.round(analysisIntervalMs/1000)} route=${routeConfig.protocol}`);
  ws.send(JSON.stringify({
    type: 'SYSTEM_INIT',
    data: {
      provider: currentProvider,
      hasUserKey: Boolean(currentApiKey),
      emergencyPause,
      maxSlippageBps,
      maxTradeAmountEth,
      selectedPair,
      analysisIntervalSec: Math.round(analysisIntervalMs / 1000),
      routeProtocol: routeConfig.protocol,
      v4Fee: routeConfig.v4Fee,
      v4TickSpacing: routeConfig.v4TickSpacing,
      v4HooksAddress: routeConfig.v4HooksAddress,
      v4HookPermissions: routeConfig.v4HookPermissions,
      connectedAt: new Date().toISOString()
    }
  }));
  console.log(`🔌 [WS] SYSTEM_INIT body →`, JSON.stringify({ provider: currentProvider, selectedPair, analysisIntervalSec: Math.round(analysisIntervalMs/1000), maxSlippageBps, emergencyPause, maxTradeAmountEth }));


  ws.on('close', () => {
    console.log('🔌 [WebSocket Server] Dashboard client disconnected.');
    clients.delete(ws);
  });
});

function broadcast(event: { type: string; payload: any }) {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// REST Endpoints
app.get('/api/health', (req, res) => {
  return res.json({
    status: 'online',
    engine: 'Rust Tokio Async',
    orchestrator: 'TypeScript Node.js',
    aiProvider: currentProvider,
    hasUserKey: Boolean(currentApiKey),
    emergencyPause,
    maxTradeAmountEth,
    selectedPair,
    routeProtocol: routeConfig.protocol,
    rpcConfigured: rpcConfig.configured,
    activeWsClients: clients.size
  });
});

// Endpoint called by the Rust Engine
app.post('/api/trigger', async (req, res) => {
  const trigger: MarketTrigger = req.body;
  console.log(`🤖 [TRusT-AI Server] Trigger received from Rust Engine | Block #${trigger.block_number} | Pair: ${trigger.pair}`);

  if (emergencyPause) {
    console.log('🛑 [Risk Control] Emergency pause active! Ignoring order execution.');
    broadcast({
      type: 'EMERGENCY_PAUSE_ACTIVE',
      payload: { trigger, timestamp: new Date().toISOString() }
    });
    return res.json({ status: 'paused', reason: 'Emergency pause active', monitored_pair: selectedPair });
  }

  // User-selected pair filter.
  // The Unichain Sepolia playground pair can be canonicalized either as
  // "mUSDT/mUSDC" or "mUSDC/mUSDT" depending on the dashboard token-picker
  // order and what the engine last echoed as monitored_pair. Treat both
  // orderings as the same playground pair so a mismatch in canonicalization
  // does not silently filter every trigger and stall the swap card.
  const playgroundPairIds = ['mUSDT/mUSDC', 'mUSDC/mUSDT'];
  const isPlayground = playgroundPairIds.includes(selectedPair);
  const triggerIsPlayground = playgroundPairIds.includes(trigger.pair);

  if (selectedPair !== 'ALL') {
    if (isPlayground && triggerIsPlayground) {
      // Playground bypass: accept either canonicalization.
    } else if (trigger.pair !== selectedPair) {
      console.log(`🔇 [Pair Filter] Pair ${trigger.pair} ignored (selected: ${selectedPair})`);
      return res.json({ status: 'filtered', reason: `Pair ${trigger.pair} not selected`, monitored_pair: selectedPair });
    }
  }

  // Throttle: enforce the minimum interval between AI analyses
  const now = Date.now();
  if (now - lastAnalysisTime < analysisIntervalMs) {
    const waitSec = ((analysisIntervalMs - (now - lastAnalysisTime)) / 1000).toFixed(1);
    console.log(`⏱️ [Throttle] Analysis ignored. Next allowed in ${waitSec}s`);
    return res.json({ status: 'throttled', reason: `Rate limited. Next in ${waitSec}s`, monitored_pair: selectedPair });
  }

  // Phase 4 — live market price. The engine's synthetic price is a placeholder
  // until the Rust loop streams real chain data; here we resolve the REAL pool
  // price (slot0 via the user's RPC, mUSDC/mUSDT playground first-class) with a
  // CoinGecko ratio fallback, and pass it to the LLM prompt. The trigger shown
  // in the dashboard/feed carries the live price + its source label so all
  // three surfaces (monitor card, prompt, feed) agree on one number.
  const effectiveTrigger = (isPlayground && triggerIsPlayground && trigger.pair !== selectedPair)
    ? { ...trigger, pair: selectedPair }
    : trigger;
  const networkForPrice = (rpcConfig.configured && rpcConfig.network ? rpcConfig.network : (process.env.NETWORK_NAME || 'sepolia')).toLowerCase();
  const live = await getLivePairPrice(effectiveTrigger.pair, networkForPrice, effectiveTrigger.current_price);
  effectiveTrigger.current_price = live.price;
  console.log(`💰 [Live Price] ${effectiveTrigger.pair} = ${live.price.toFixed(6)} (source: ${live.source})`);

  // Generate a decision through the selected AI provider. The per-signal
  // budget caps the amount the agent may propose (mock clamp + LLM prompt).
  const decision: AIDecision = await generateAIDecision(effectiveTrigger, currentProvider, currentApiKey, maxTradeAmountEth, pairBaseSymbol(effectiveTrigger.pair));
  lastAnalysisTime = Date.now();
  (decision as AIDecision & { price_source?: string }).price_source = live.source;

  console.log(`🧠 [LLM Decision] Provider: ${decision.provider_used} | Action: ${decision.action} (${(decision.confidence * 100).toFixed(0)}% Confidence)`);
  console.log(`📊 [LLM Decision] Pair=${effectiveTrigger.pair} gas=${effectiveTrigger.gas_price_gwei.toFixed(2)} slippage=${effectiveTrigger.estimated_slippage_percent.toFixed(2)} price=${effectiveTrigger.current_price.toFixed(4)} change24h=${effectiveTrigger.price_change_24h.toFixed(2)} liquidity=${(effectiveTrigger.liquidity_depth_usd/1e6).toFixed(2)}M`);
  console.log(`📡 [LLM Decision] decision payload (summary):`, JSON.stringify({ action: decision.action, confidence: decision.confidence, reasoning: decision.reasoning, suggested_amount_eth: decision.suggested_amount_eth, max_slippage_bps: decision.max_slippage_bps, mev_risk_level: decision.mev_risk_level, provider_used: decision.provider_used, hasSwapData: !!decision.uniswap_swap_data }));

  // Broadcast the event in real time via WebSocket to the React dashboard.
  // If we normalized the playground canonicalization above, broadcast the
  // normalized trigger so the swap card UI and logs agree on the pair id.
  broadcast({
    type: 'NEW_DECISION',
    payload: {
      trigger: effectiveTrigger,
      decision
    }
  });

  return res.json({
    status: 'success',
    trigger,
    decision,
    monitored_pair: selectedPair,
    price_source: live.source
  });
});

// Settings update endpoint called by the dashboard frontend
app.post('/api/settings', (req, res) => {
  const { provider, apiKey, pause, maxSlippage, pair, analysisInterval, maxTradeAmount, rpcUrl, rpcProvider, rpcNetwork } = req.body;

  if (provider) currentProvider = provider;
  if (typeof apiKey === 'string') currentApiKey = apiKey;
  if (typeof pause === 'boolean') emergencyPause = pause;
  if (maxSlippage) maxSlippageBps = maxSlippage;
  if (typeof pair === 'string') selectedPair = pair;
  if (typeof analysisInterval === 'number' && analysisInterval >= 5) {
    analysisIntervalMs = analysisInterval * 1000;
  }
  // Mock-pair provider is intentionally default-fast so the synthetic playground
  // signal fires often enough to be useful during manual testing. Needs no key.
  if (provider === 'mock_pair') {
    analysisIntervalMs = Math.max(5000, analysisIntervalMs);
  }
  // Per-signal trade budget: must be a finite number above zero (the dashboard
  // enforces "below wallet balance" client-side; the server has no wallet).
  if (maxTradeAmount !== undefined) {
    const budget = Number(maxTradeAmount);
    if (!Number.isFinite(budget) || budget <= 0) {
      return res.status(400).json({ success: false, error: 'maxTradeAmount must be a finite number greater than zero.' });
    }
    maxTradeAmountEth = budget;
  }
  // RPC plug-in (keys modal). Only the full URL is kept; it is NOT echoed in
  // WebSocket broadcasts or logs. Passing an empty string clears the config.
  if (typeof rpcUrl === 'string') {
    if (rpcUrl.trim() === '') {
      rpcConfig = { configured: false, provider: '', url: '', network: process.env.NETWORK_NAME || 'sepolia' };
    } else {
      rpcConfig = {
        configured: true,
        provider: typeof rpcProvider === 'string' ? rpcProvider : 'custom',
        url: rpcUrl.trim(),
        network: typeof rpcNetwork === 'string' && rpcNetwork ? rpcNetwork : (process.env.NETWORK_NAME || 'sepolia')
      };
    }
  }
  // v4 PoolKey/hook fields (the only route — see routeConfig above). The
  // dashboard validates the hook address client-side (getHookPermissions on
  // the v4 PoolManager) and passes the flags summary along so the LLM prompt
  // can factor them in. `routeProtocol` from older clients is accepted but
  // ignored: v4 is the only route.
  if (typeof req.body.v4Fee === 'number' && Number.isFinite(req.body.v4Fee) && req.body.v4Fee > 0) {
    routeConfig.v4Fee = Math.floor(req.body.v4Fee);
  }
  if (typeof req.body.v4TickSpacing === 'number' && Number.isFinite(req.body.v4TickSpacing) && req.body.v4TickSpacing > 0) {
    routeConfig.v4TickSpacing = Math.floor(req.body.v4TickSpacing);
  }
  if (typeof req.body.v4HooksAddress === 'string') {
    const h = req.body.v4HooksAddress.trim();
    // Accept a valid 0x address or an empty string (no hook); anything else is
    // rejected silently so a malformed hook never poisons the PoolKey.
    routeConfig.v4HooksAddress = /^0x[0-9a-fA-F]{40}$/.test(h) ? h.toLowerCase() : '';
  }
  if (typeof req.body.v4HookPermissions === 'string') {
    routeConfig.v4HookPermissions = req.body.v4HookPermissions.slice(0, 400);
  }
  console.log(`⚙️ [Config] Settings updated: Provider=${currentProvider}, Pair=${selectedPair}, Interval=${analysisIntervalMs/1000}s, Pause=${emergencyPause}, MaxSlippage=${maxSlippageBps}bps, MaxBudget=${maxTradeAmountEth} ${pairBaseSymbol(selectedPair)}, Route=v4 (fee=${routeConfig.v4Fee}, tick=${routeConfig.v4TickSpacing}, hook=${routeConfig.v4HooksAddress || 'none'})${rpcConfig.configured ? `, RPC=${rpcConfig.provider}/${rpcConfig.network}` : ''}`);
  if (provider === 'mock_pair') {
    console.log('🧪 [Mock Pair] Unichain Sepolia mUSDC/mUSDT playground enabled. Synthesizes signals for the deployed mock pools (user-deployed v4 pool — route selected in the dashboard.');
  }
  console.log(`⚙️ [Config] activeProvider now=${currentProvider} selectedPair=${selectedPair} intervalMs=${analysisIntervalMs}`);

  broadcast({
    type: 'SETTINGS_UPDATED',
    payload: {
      provider: currentProvider,
      hasUserKey: Boolean(currentApiKey),
      emergencyPause,
      maxSlippageBps,
      maxTradeAmountEth,
      selectedPair,
      analysisIntervalSec: Math.round(analysisIntervalMs / 1000),
      routeProtocol: routeConfig.protocol,
      v4Fee: routeConfig.v4Fee,
      v4TickSpacing: routeConfig.v4TickSpacing,
      v4HooksAddress: routeConfig.v4HooksAddress,
      v4HookPermissions: routeConfig.v4HookPermissions
    }
  });

  return res.json({
    success: true,
    currentProvider,
    hasUserKey: Boolean(currentApiKey),
    emergencyPause,
    maxSlippageBps,
    maxTradeAmountEth,
    selectedPair,
    analysisIntervalSec: Math.round(analysisIntervalMs / 1000),
    routeProtocol: routeConfig.protocol,
    v4Fee: routeConfig.v4Fee,
    v4TickSpacing: routeConfig.v4TickSpacing,
    v4HooksAddress: routeConfig.v4HooksAddress,
    v4HookPermissions: routeConfig.v4HookPermissions
  });
});

// Served to the Rust Engine so the dashboard's RPC plug-in (set from the API
// Keys modal) reaches the engine without editing .env. Only reachable on the
// local/dev network; do not expose this server publicly (see docs/SECURITY.md).
app.get('/api/rpc-config', (_req, res) => {
  return res.json(rpcConfig);
});

// Plug-and-play credential validation for the dashboard's Configuration modal:
// proves an RPC endpoint and/or an LLM API key actually work BEFORE the user
// saves them. The RPC probe runs a real eth_chainId + eth_blockNumber; the LLM
// probe runs a minimal real request per provider. Keys arrive in the request
// body and are never logged, echoed back, or persisted.
const VALIDATE_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = VALIDATE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return 'invalid or unauthorized API key';
  if (status === 429) return 'rate limited (HTTP 429) — quota exceeded, try again later';
  if (status >= 500) return 'provider server error (HTTP ' + status + ')';
  return 'unexpected provider response (HTTP ' + status + ')';
}

// Chain id each network key in the dashboard's RPC dropdown must resolve to.
// Used to cross-check the pasted endpoint against the selected network at
// SAVE time — an Alchemy/Infura URL is provider-shaped for every network, so
// a "Unichain" dropdown entry with an "Ethereum mainnet" key would probe
// green (the URL answers eth_chainId!) while silently pointing at the wrong
// chain. This is exactly what caused false chain-mismatch blocks on swaps:
// the route label came from this network setting, not from the wallet.
const CHAIN_ID_BY_NETWORK_KEY: Record<string, number> = {
  sepolia: 11155111,
  'unichain-sepolia': 1301,
  unichain: 130,
  mainnet: 1,
};

// Probes an Ethereum JSON-RPC endpoint (eth_chainId + eth_blockNumber) and
// returns the normalized result. Never throws.
async function validateRpcEndpoint(url: string): Promise<{ ok: boolean; error?: string; chainId?: number; blockNumber?: number }> {
  try {
    new URL(url);
  } catch {
    return { ok: false, error: 'URL malformed — paste the full endpoint (https://…) including the key segment' };
  }
  try {
    const rpc = async (method: string): Promise<any> => {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] })
      });
      if (!res.ok) throw new Error(describeHttpFailure(res.status));
      const body = await res.json();
      if (body.error) throw new Error(`JSON-RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
      return body.result;
    };
    const chainHex = await rpc('eth_chainId');
    const blockHex = await rpc('eth_blockNumber');
    return {
      ok: true,
      chainId: Number(BigInt(chainHex)),
      blockNumber: Number(BigInt(blockHex))
    };
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? 'endpoint timed out after 8s'
      : (e?.message || 'endpoint unreachable');
    return { ok: false, error: msg };
  }
}

// Probes an LLM API key with the cheapest real request per provider. The key
// is sent in the body of this local request only — never logged. Ollama is the
// exception: it runs locally and needs no key, so the probe is a connectivity
// check for the configured server + model.
async function validateLlmKey(provider: string, key: string): Promise<{ ok: boolean; error?: string; model?: string }> {
  if (provider === 'ollama') {
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'deepseek-r1:latest';
    try {
      const res = await fetchWithTimeout(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'Reply with the single word: ok', stream: false })
      });
      if (!res.ok) {
        // Ollama reports a missing model as HTTP 404 with a JSON error body —
        // surface its message ("model \"x\" not found, try pulling it first").
        let detail = '';
        try {
          const errBody = await res.json();
          detail = typeof errBody?.error === 'string' ? errBody.error : '';
        } catch { /* keep the generic message */ }
        return { ok: false, error: detail || describeHttpFailure(res.status) };
      }
      return { ok: true, model };
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return { ok: false, error: `Ollama did not answer within 8s — the model may still be loading, try again` };
      }
      const code = e?.cause?.code ?? e?.code;
      if (code === 'ECONNREFUSED') {
        return { ok: false, error: `Ollama server not reachable at ${ollamaUrl} — is it running? (ollama serve)` };
      }
      return { ok: false, error: e?.message || 'request to Ollama failed' };
    }
  }
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty API key' };
  try {
    if (provider === 'ollama_cloud') {
      const model = process.env.OLLAMA_CLOUD_MODEL || 'gemma4:31b';
      const res = await fetchWithTimeout('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${trimmed}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          stream: false
        })
      });
      if (!res.ok) {
        // Prefer the API's own message when present (401 invalid key, 404
        // unknown cloud model, 429 quota — the body says which).
        let detail = '';
        try {
          const errBody = await res.json();
          detail = typeof errBody?.error === 'string' ? errBody.error : '';
        } catch { /* keep the generic message */ }
        return { ok: false, error: detail || describeHttpFailure(res.status) };
      }
      return { ok: true, model };
    }
    if (provider === 'anthropic') {
      const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
        })
      });
      if (!res.ok) return { ok: false, error: describeHttpFailure(res.status) };
      return { ok: true, model: 'claude-3-5-haiku' };
    }
    if (provider === 'gemini') {
      const model = 'gemini-2.5-flash';
      const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': trimmed },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 }
        })
      });
      if (!res.ok) {
        // Prefer the API's own message when present (more specific than the
        // generic HTTP description).
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody?.error?.message ?? '';
        } catch { /* keep the generic message */ }
        return { ok: false, error: detail ? `${describeHttpFailure(res.status)} — ${detail}` : describeHttpFailure(res.status) };
        }
      return { ok: true, model };
    }
    if (provider === 'openai' || provider === 'deepseek') {
      const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
      const model = provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';
      const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${trimmed}` },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
        })
      });
      if (!res.ok) return { ok: false, error: describeHttpFailure(res.status) };
      return { ok: true, model };
    }
    return { ok: false, error: `provider "${provider}" does not need a key (mock providers are always available)` };
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? `no response from ${provider} within 8s — check your connection`
      : (e?.message || 'request failed');
    return { ok: false, error: msg };
  }
}

app.post('/api/validate', async (req, res) => {
  try {
    const body = req.body || {};
    const out: Record<string, unknown> = { validatedAt: new Date().toISOString() };

    if (body.rpcUrl !== undefined) {
      const url = typeof body.rpcUrl === 'string' ? body.rpcUrl.trim() : '';
      const probe = url ? await validateRpcEndpoint(url) : { ok: false as const, error: 'empty RPC URL' };
      // Cross-check the endpoint's actual chain against the dropdown network:
      // probe green on the wrong chain is still a misconfiguration.
      if (probe.ok && typeof body.rpcNetwork === 'string') {
        const expected = CHAIN_ID_BY_NETWORK_KEY[body.rpcNetwork.toLowerCase()];
        if (expected !== undefined && probe.chainId !== expected) {
          out.rpc = {
            ok: false,
            error: `Endpoint answers chain ${probe.chainId}, but you selected "${body.rpcNetwork}" (chain ${expected}). Align the network dropdown with the endpoint, then save.`
          };
        } else {
          out.rpc = probe;
        }
      } else {
        out.rpc = probe;
      }
    }
    if (body.llmProvider !== undefined) {
      const provider = String(body.llmProvider || '').toLowerCase();
      const key = typeof body.apiKey === 'string' ? body.apiKey : '';
      out.llm = await validateLlmKey(provider, key);
    }
    return res.json(out);
  } catch (e) {
    console.error('[Validate] unexpected failure:', (e as Error).message);
    return res.status(500).json({ error: 'validation failed' });
  }
});

// Manual force-swap trigger for the dashboard so the user can exercise the
// playground swap path on demand (e.g. Unichain Sepolia mUSDC/mUSDT) without
// waiting for a Rust engine block or relying on the AI throttle.
app.post('/api/force-swap', async (req, res) => {
  try {
    const body = req.body || {};
    const pairOverrides = body.pair ? [body.pair] : undefined;
    const amountOverrides = body.suggested_amount_eth != null ? [Number(body.suggested_amount_eth)] : undefined;

    // Build a synthetic playground trigger that points at the real Unichain
    // Sepolia test pool and the correct mock token addresses so the swap card
    // builds real calldata the user can sign.
    const playgroundPairId = 'mUSDC/mUSDT';
    // The caller may override the playground target in case a different
    // playground pair is ever wired from the UI. If omitted, fall back to the
    // canonical Unichain Sepolia playground pair.
    //
    // IMPORTANT: the requested pair is used ONLY to build this synthetic
    // trigger; it must never leak into the global selectedPair or into the
    // settings/pair config path, which would poison the orchestrator config
    // and the Rust catalog path.
    const requestedPair = (body?.pair && typeof body.pair === 'string') ? body.pair : playgroundPairId;
    const playgroundBase = '0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860'; // mUSDC (base)
    const playgroundQuote = '0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06'; // mUSDT (quote)
    const playgroundPool = '0x7a517eb3525cf73f408eb8e1c883441be7a5b857';

    // Build a synthetic playground trigger using the requested pair id and
    // the correct mock token addresses so the server can build real v4
    // calldata for the swap card. Do NOT write this pair back into the global
    // selectedPair — that would poison the Rust catalog path and the filter.
    const finalPairId = requestedPair;
    const isCanonicalOrdering = finalPairId === 'mUSDC/mUSDT';
    const tokenIn = isCanonicalOrdering ? playgroundBase : playgroundQuote;
    const tokenOut = isCanonicalOrdering ? playgroundQuote : playgroundBase;
    const trigger: MarketTrigger = {
      block_number: Math.floor(Math.random() * 1000000) + 19_842_100,
      block_hash: `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
      pair: finalPairId,
      token_in: tokenIn,
      token_out: tokenOut,
      pool_address: playgroundPool,
      current_price: 1.005,
      price_change_24h: 0.62,
      gas_price_gwei: 18.5,
      estimated_slippage_percent: 0.12,
      liquidity_depth_usd: 1_200_000,
      timestamp: new Date().toISOString()
    };

    // If the caller supplied an amount, clamp it to the current budget cap so
    // the dashboard can still run its pre-execution budget check.
    let suggestedAmount = 0.03; // base token units (mUSDC) by default
    if (amountOverrides && amountOverrides.length > 0) {
      const raw = amountOverrides[0];
      if (Number.isFinite(raw) && raw > 0) {
        suggestedAmount = Math.min(raw, maxTradeAmountEth);
      }
    }

    // Build a mock BUY decision + real v4 calldata for the playground pair.
    const decision: AIDecision = {
      action: 'BUY',
      confidence: 0.95,
      reasoning: 'Manual force-swap test triggered from the dashboard — exercising the Unichain Sepolia mUSDC/mUSDT swap pipeline end-to-end.',
      suggested_amount_eth: suggestedAmount,
      max_slippage_bps: maxSlippageBps,
      mev_risk_level: 'LOW',
      provider_used: 'TRusT-AI Force Test (Dashboard)',
      timestamp: new Date().toISOString()
    };

    let uniswap_swap_data: UniswapSwapData | undefined = undefined;
    try {
      uniswap_swap_data = await getUniswapSwapData(
        trigger,
        'BUY',
        suggestedAmount,
        maxSlippageBps
      );
    } catch (e) {
      console.error('[Force Swap] Failed to build playground swap calldata:', (e as Error).message);
    }

    decision.uniswap_swap_data = uniswap_swap_data;
    decision.tx_hash_simulated = decision.uniswap_swap_data ? `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}` : undefined;

    // Broadcast like a real NEW_DECISION so the dashboard swap card opens.
    broadcast({
      type: 'NEW_DECISION',
      payload: {
        trigger,
        decision
      }
    });

    return res.json({
      status: 'success',
      playground: true,
      pair: playgroundPairId,
      decision,
      monitored_pair: selectedPair
    });
  } catch (e) {
    console.error('[Force Swap] Unhandled error:', (e as Error).message);
    return res.status(500).json({ status: 'error', error: (e as Error).message });
  }
});

server.listen(Number(PORT), BIND_HOST, () => {
  console.log(`🧠 [TRusT-AI Server] Node/TS Orchestrator running at http://${BIND_HOST}:${PORT}`);
  console.log(`📡 WebSocket Gateway active on the same port.`);
});


