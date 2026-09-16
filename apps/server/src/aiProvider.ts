import { getUniswapSwapData, UniswapSwapData } from './uniswapApi.js';
import { routeConfig } from './index.js';

export interface MarketTrigger {
  block_number: number;
  block_hash: String;
  pair: string;
  token_in: string;
  token_out: string;
  pool_address: string;
  current_price: number;
  price_change_24h: number;
  gas_price_gwei: number;
  estimated_slippage_percent: number;
  liquidity_depth_usd: number;
  timestamp: string;
}

export interface AIDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggested_amount_eth: number;
  max_slippage_bps: number;
  mev_risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  provider_used: string;
  timestamp: string;
  tx_hash_simulated?: string;
  uniswap_swap_data?: UniswapSwapData;
}

// Normalizes an LLM decision payload against the user's per-trade budget:
// clamps suggested_amount_eth into (0, cap] (0 when HOLD), bounds confidence,
// and falls back to safe defaults for missing/invalid fields. Real providers
// can drift from the prompt contract, so every response passes through here.
function sanitizeDecision(raw: any, providerUsed: string, budgetCap: number): AIDecision {
  const action: AIDecision['action'] = raw?.action === 'BUY' || raw?.action === 'SELL' ? raw.action : 'HOLD';
  const confidence = Math.min(1, Math.max(0, Number(raw?.confidence) || 0.88));
  const rawAmount = Number(raw?.suggested_amount_eth);
  const suggested_amount_eth =
    action === 'HOLD'
      ? 0
      : Math.round(Math.min(budgetCap, Math.max(0.001, Number.isFinite(rawAmount) ? rawAmount : 0.1)) * 10000) / 10000;
  const max_slippage_bps = Number(raw?.max_slippage_bps) > 0 ? Number(raw?.max_slippage_bps) : 50;
  const mev_risk_level: AIDecision['mev_risk_level'] =
    raw?.mev_risk_level === 'HIGH' || raw?.mev_risk_level === 'MEDIUM' ? raw.mev_risk_level : 'LOW';
  return {
    action,
    confidence,
    reasoning:
      typeof raw?.reasoning === 'string' && raw.reasoning
        ? raw.reasoning
        : `Volatility analysis on current market conditions (provider: ${providerUsed}).`,
    suggested_amount_eth,
    max_slippage_bps,
    mev_risk_level,
    provider_used: providerUsed,
    timestamp: new Date().toISOString()
  };
}

// Attaches executable Uniswap v4 swap data to a non-HOLD decision so the
// dashboard gets the 1-click swap card from EVERY provider (real LLMs and
// mock alike). The calldata is built server-side by getUniswapSwapData —
// the LLM only decides action/amount/slippage; it never emits calldata, so a
// hallucinated payload can never reach the wallet. minAmountOut is anchored
// to a live V4Quoter quote through the user's configured RPC (fallback to the
// synthetic band when the quoter is unreachable), and errors (unknown token
// decimals, unsupported network, quoter failures) degrade gracefully to a
// decision without a swap card — the invariant "always a valid AIDecision"
// is never broken.
async function withSwapData(decision: AIDecision, trigger: MarketTrigger): Promise<AIDecision> {
  if (decision.action !== 'HOLD') {
    try {
      decision.uniswap_swap_data = await getUniswapSwapData(
        trigger,
        decision.action,
        decision.suggested_amount_eth || 0.1,
        decision.max_slippage_bps || 50
      );
    } catch (e) {
      console.warn(`[Uniswap API] Error generating swap calldata (${decision.provider_used}): ${(e as Error).message}`);
    }
  }
  return decision;
}

export async function generateAIDecision(
  trigger: MarketTrigger,
  providerOverride?: string,
  userApiKey?: string,
  maxTradeAmountEth: number = 0.25,
  // Unit symbol of the cap (base token of the monitored pair, e.g. WETH for
  // WETH/USDC). Informational for the LLM prompt; the clamp is numeric.
  budgetToken: string = 'WETH'
): Promise<AIDecision> {
  const provider = (providerOverride || process.env.LLM_PROVIDER || 'mock').toLowerCase();
  const apiKey = userApiKey || process.env.AI_API_KEY || '';
  // Effective cap: always strictly positive so a misconfigured 0 never freezes
  // the agent or lets an LLM propose the whole wallet.
  const budgetCap = Math.max(0.001, Number(maxTradeAmountEth) || 0.25);

  // Active swap route context (v4 primary in this project). Build a concise
  // human-readable description for the LLM prompt so the agent can factor
  // route settings and optional hook permissions into sizing and risk.
  const activeRoute = routeConfig
    ? `Uniswap ${routeConfig.protocol} (fee ${routeConfig.v4Fee}, tick spacing ${routeConfig.v4TickSpacing}`
      + (routeConfig.v4HooksAddress
        ? `, hook ${routeConfig.v4HooksAddress}${routeConfig.v4HookPermissions ? ` [${routeConfig.v4HookPermissions}]` : ''}`
        : ', no hook')
      + ')'
    : 'Uniswap v4';

  // Build a compact prompt for downstream LLM providers. Keep it strict but
  // human-readable so fallback mock parsing and heuristic providers behave.
  const prompt = `You are an autonomous DeFi trading risk AI. Given the MarketTrigger below, return STRICT JSON only with keys: action (BUY|SELL|HOLD), confidence (0.0-1.0), reasoning (string), suggested_amount_eth (number, >0 when not HOLD and <= ${budgetCap} ${budgetToken}), max_slippage_bps (number), mev_risk_level (LOW|MEDIUM|HIGH).

Market Trigger:
- Pair: ${trigger.pair}
- Current Price: $${trigger.current_price.toFixed(4)}
- 24h Price Change: ${trigger.price_change_24h.toFixed(2)}%
- Gas Price: ${trigger.gas_price_gwei.toFixed(1)} Gwei
- Estimated Slippage: ${trigger.estimated_slippage_percent.toFixed(2)}%
- Pool Liquidity: $${(trigger.liquidity_depth_usd / 1_000_000).toFixed(2)}M
- Max Trade Budget: ${budgetCap} ${budgetToken}
- Active Swap Route: ${activeRoute}

If the active route includes a v4 hook, factor its lifecycle permissions (dynamic fees, MEV protection, access control) into your sizing and slippage. If a hook blocks the requested behavior, respond with action = "HOLD" and include the reason in the reasoning field.

When your decision is BUY or SELL, the orchestrator converts it into executable Uniswap v4 Universal Router calldata server-side (you never emit calldata): the amount you propose becomes the swap input and max_slippage_bps becomes the on-chain slippage guard, so set max_slippage_bps deliberately (20-100 for liquid pairs, higher only when volatility justifies it).

Return JSON only (no surrounding text).`;

  // 1. Ollama (local models: Llama 3, DeepSeek-R1)
  if (provider === 'ollama') {
    try {
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'deepseek-r1:latest';
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          format: 'json'
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        const parsed = JSON.parse(data.response);
        return withSwapData(sanitizeDecision(parsed, `Ollama (${model})`, budgetCap), trigger);
      }
    } catch (e) {
      console.warn(`[AI Provider] Local Ollama failed, falling back to Mock Engine: ${(e as Error).message}`);
    }
  }

  // 1b. Ollama Cloud (ollama.com) — the hosted flavor of the same API. Key
  // required (Authorization: Bearer), no local install needed. Model names are
  // the cloud catalog ids (e.g. gemma4:31b, qwen3-coder:480b-cloud) as listed
  // by https://ollama.com/api/tags; OLLAMA_CLOUD_MODEL overrides the default.
  // format:'json' + a JSON-extracting regex keep the strict-JSON contract.
  if (provider === 'ollama_cloud' && apiKey) {
    try {
      const model = process.env.OLLAMA_CLOUD_MODEL || 'gemma4:31b';
      const res = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          format: 'json'
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        const content: string | undefined = data?.message?.content;
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return withSwapData(sanitizeDecision(parsed, `Ollama Cloud (${model})`, budgetCap), trigger);
          }
        }
      } else {
        console.warn(`[AI Provider] Ollama Cloud responded with status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`[AI Provider] Ollama Cloud failed, falling back to Mock Engine: ${(e as Error).message}`);
    }
  }

  // 2. Anthropic Claude API
  if (provider === 'anthropic' && apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        const contentText = data.content[0].text;
        const jsonMatch = contentText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return withSwapData(sanitizeDecision(parsed, 'Claude 3.5 Haiku', budgetCap), trigger);
        }
      } else {
        console.warn(`[AI Provider] Anthropic API responded with status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`[AI Provider] Anthropic API failed: ${(e as Error).message}`);
    }
  }

  // 3. OpenAI / DeepSeek API (OpenAI-compatible format)
  if ((provider === 'openai' || provider === 'deepseek') && apiKey) {
    try {
      const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
      const model = provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are an autonomous DeFi trading risk AI. Return valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' }
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        const parsed = JSON.parse(data.choices[0].message.content);
        return withSwapData(sanitizeDecision(parsed, `${provider.toUpperCase()} (${model})`, budgetCap), trigger);
      } else {
        console.warn(`[AI Provider] API ${provider} responded with status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`[AI Provider] API ${provider} failed, falling back to Mock Engine: ${(e as Error).message}`);
    }
  }

  // 2b. Google Gemini API (generativelanguage.googleapis.com). Uses
  // generationConfig.responseMimeType = "application/json" for strict JSON
  // output — the same strict-JSON contract the other providers honor. The key
  // goes in the x-goog-api-key header (never logged).
  if (provider === 'gemini' && apiKey) {
    try {
      const model = 'gemini-2.5-flash';
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are an autonomous DeFi trading risk AI. Return valid JSON only.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json'
          }
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        const text: string | undefined = data?.candidates?.[0]?.content?.parts
          ?.map((p: any) => p?.text ?? '')
          .join('');
        if (text) {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return withSwapData(sanitizeDecision(parsed, `Gemini (${model})`, budgetCap), trigger);
          }
        }
      } else {
        console.warn(`[AI Provider] Gemini API responded with status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`[AI Provider] Gemini API failed, falling back to Mock Engine: ${(e as Error).message}`);
    }
  }

  // 3. Smart fallback / high-fidelity Mock provider (default out-of-the-box)
  const isUp = trigger.price_change_24h > 0.5;
  const isDown = trigger.price_change_24h < -0.5;
  const highGas = trigger.gas_price_gwei > 32;

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 0.88;
  let reasoning = `Volatility of ${trigger.price_change_24h.toFixed(2)}% within the tolerance limit. Holding position in liquidity to minimize gas impact (${trigger.gas_price_gwei.toFixed(1)} Gwei).`;
  let suggested_amount_eth = 0.0;
  let max_slippage_bps = 50;
  let mev_risk_level: 'LOW' | 'MEDIUM' | 'HIGH' = highGas ? 'HIGH' : 'LOW';

  if (isUp && !highGas && trigger.estimated_slippage_percent < 0.25) {
    action = 'BUY';
    confidence = 0.94;
    suggested_amount_eth = Math.min(0.15, budgetCap);
    reasoning = `Accumulation pattern detected on pair ${trigger.pair}. Liquidity depth ($${(trigger.liquidity_depth_usd / 1e6).toFixed(2)}M) allows an optimized entry with an estimated slippage of only ${trigger.estimated_slippage_percent.toFixed(2)}%.`;
  } else if (isDown && trigger.estimated_slippage_percent < 0.35) {
    action = 'SELL';
    confidence = 0.91;
    suggested_amount_eth = Math.min(0.10, budgetCap);
    reasoning = `Sell pressure identified at block #${trigger.block_number}. Performing automatic risk rebalancing to protect capital against a local retracement.`;
  }

  // Deterministic synthetic signal for pairs that don't trigger the heuristic
  // thresholds (this is what makes the user-deployed mUSDC/mUSDT playground
  // testable without a real price move). For mock_pair we just emit a BUY
  // every 3rd block the engine streams for that pair, the rest HOLD.
  //
  // NOTE: the pair id the engine resolves is "mUSDC/mUSDT" (quote/base mirror
  // of how the pool was deployed). The dashboard writes "mUSDT/mUSDC", which
  // the orchestrator and engine echo back as monitored_pair, so both forms can
  // appear at runtime. Normalize here so the synthetic signal fires for either
  // label as long as the tokens are the Unichain Sepolia mock pair.
  const normalizedPair = (() => {
    if (trigger.pair === 'mUSDC/mUSDT' || trigger.pair === 'mUSDT/mUSDC') return 'mUSDC/mUSDT';
    if (trigger.token_in && trigger.token_out) {
      const lowerIn = trigger.token_in.toLowerCase();
      const lowerOut = trigger.token_out.toLowerCase();
      if (lowerIn === '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860' && lowerOut === '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06') return 'mUSDC/mUSDT';
      if (lowerIn === '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06' && lowerOut === '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860') return 'mUSDT/mUSDC';
    }
    return trigger.pair;
  })();

  // Both "mUSDC/mUSDT" and "mUSDT/mUSDC" must be treated as the same
  // Unichain Sepolia playground pair, because the dashboard pickup order can
  // canonicalize it either way and the engine may stream either label.
  //
  // TEMPORARY: normally this playground signal is rate-limited by epoch so the
  // user is not flooded, but for initial validation we force BUY on every
  // playground trigger so the swap card appears immediately on the next block.
  // Reinstate the `epoch % 3 === 0` gate before enabling a real provider or
  // long-running session.
  if (provider === 'mock_pair' && (normalizedPair === 'mUSDC/mUSDT' || normalizedPair === 'mUSDT/mUSDC')) {
    action = 'BUY';
    confidence = 0.92;
    suggested_amount_eth = Math.min(0.05, budgetCap);
    const epoch = Math.floor(trigger.block_number / 3);
    reasoning = `Synthetic playground signal for the mUSDT/mUSDC pools on Unichain Sepolia — block #${trigger.block_number} (epoch ${epoch}). Emitting a BUY on every playground trigger so the swap card can be validated immediately (user-deployed v4 pool 0x7a517eb3525cf73f408eb8e1c883441be7a5b857.`;
    console.log(`🧪 [Mock Pair] Emitting synthetic BUY for ${normalizedPair} on block #${trigger.block_number} (epoch ${epoch}).`);
  }

  // Generate a simulated transaction hash on Ethereum Sepolia
  const txHash = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;

  // Swap data for the mock path flows through the same helper as the real
  // providers (server-built v4 calldata + live-quoted min-out). Playground
  // (mock_pair) signals populate the swap card + execute button the same way.
  const uniswap_swap_data = action !== 'HOLD'
    ? (await withSwapData({
        action,
        confidence,
        reasoning,
        suggested_amount_eth,
        max_slippage_bps,
        mev_risk_level,
        provider_used: provider === 'mock' ? 'TRusT-AI Mock Engine' : `${provider.toUpperCase()} (Fallback)`,
        timestamp: new Date().toISOString()
      }, trigger)).uniswap_swap_data
    : undefined;

  if (provider === 'mock_pair' && normalizedPair !== 'ALL' && (normalizedPair === 'mUSDC/mUSDT' || normalizedPair === 'mUSDT/mUSDC')) {
    console.log(`🧪 [Mock Pair] Post-decision payload (has uniswap_swap_data=${!!uniswap_swap_data}):`, JSON.stringify({ action, suggested_amount_eth, uniswap_swap_data: uniswap_swap_data ? { to_address: uniswap_swap_data.to_address, route_summary: uniswap_swap_data.route_summary, estimated_gas_units: uniswap_swap_data.estimated_gas_units, router_name: uniswap_swap_data.router_name } : null }));
  }

  return {
    action,
    confidence,
    reasoning,
    suggested_amount_eth,
    max_slippage_bps,
    mev_risk_level,
    provider_used: provider === 'mock' ? 'TRusT-AI Mock Engine' : `${provider.toUpperCase()} (Fallback)`,
    timestamp: new Date().toISOString(),
    tx_hash_simulated: action !== 'HOLD' ? txHash : undefined,
    uniswap_swap_data
  };
}
