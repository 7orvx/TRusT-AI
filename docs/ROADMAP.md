# TRusT-AI — Product & Engineering Roadmap

> Source of truth for where TRusT-AI is heading. The Portuguese working notes
> that this document was distilled from live in [`docs/internal/roadmap-pt-BR.md`](./internal/roadmap-pt-BR.md)
> (internal only, not pushed to git). Keep this file in English and in sync
> with the code and `AGENTS.md`.

## Vision

TRusT-AI is a high-performance, **non-custodial, zero-storage** DeFi SaaS
platform. Users bring their own LLM API keys (BYOM), keep full control of
their wallet, and review transparent AI reasoning before executing
route-optimized **Uniswap v4** swaps with one click. Privacy-first: no central
database, no server-side key retention, no logs of user data.

**Core promise:** *“Bring your own keys, review real-time AI reasoning, and
execute route-optimized Uniswap v4 swaps with one click — your sovereign,
open-source DeFi co-pilot.”*

---

## ✅ Phase 1 — Foundation & Infrastructure [DONE]

- [x] Monorepo: Rust Engine + Node/TS Server + React Web dashboard.
- [x] Low-latency HTTP/WebSocket communication (Windows/WSL aware).
- [x] Block simulation pipeline streaming live events to the dashboard
      (the synthetic loop stays until the Phase 4 live feed replaces it).

## ✅ Phase 2 — Real AI Integration & BYOM (Zero-Storage) [DONE]

- [x] Provider selection in the UI: OpenAI, Anthropic (Claude), DeepSeek,
      **Google Gemini**, **Ollama Cloud** (API key, ollama.com) and **Local
      Ollama** (keyless, connectivity probe) + Mock engine.
- [x] Local key management — API keys stored **only** in the browser
      (`localStorage`, key `trust_ai_api_keys`).
- [x] **Plug & play probe validation (`POST /api/validate`)** — instant
      green/red feedback BEFORE saving: RPC endpoints are probed with real
      `eth_chainId` + `eth_blockNumber`; LLM keys with the cheapest real
      request per provider (`maxOutputTokens: 8`). Broken keys/endpoints are
      never persisted; errors surface verbatim (401 invalid key, 429 rate
      limited, model not pulled, Ollama server down…). Keys are never logged.
- [x] Prompt engineering + strict economic JSON schema (`action`,
      `confidence`, `reasoning`, `suggested_amount_eth`, `max_slippage_bps`,
      `mev_risk_level`), clamped to the user's per-trade budget server-side.
- [x] **Deterministic server-side Universal Router v4 encoding** — the LLM
      decides economic intent (action/amount/slippage); the server encodes
      calldata. A hallucinated payload can never reach the wallet.
- [x] Graceful fallback chain: real providers → Mock Engine (always available);
      the “always a valid `AIDecision`” invariant is never broken.

## ✅ Phase 3 — Web3 Connection & Non-Custody [DONE]

- [x] EIP-1193 wallet connection (MetaMask/Rabby/Coinbase) and WalletConnect /
      Reown AppKit bridge (`wagmi@2.x` pinned — the only line AppKit supports).
- [x] **Single wallet state store** — AppKit modal bridged into wagmi via
      `@reown/appkit-adapter-wagmi`; injected and WalletConnect sessions both
      update the same state (header pill / network selector / swap path).
      Works in any browser AND inside the desktop WebView (no injected
      MetaMask there — WalletConnect signs on the user's phone).
- [x] **Uniswap v4 Universal Router integration** — 1-click signing on
      BUY/SELL signal cards; first real on-chain v4 swap executed on Unichain
      Sepolia (2026-09-09, block 62118440). `amountOutMinimum` anchored to a
      live V4Quoter quote (struct-vs-positional ABI encoding root cause fixed —
      see `docs/design/uniswap-routing-v3-v4-hooks.md` §10).
- [x] **Legacy Uniswap v3 purge (2026-09-15)** — SwapRouter02 encoding, v3/v4
      route selector (UI + server), recipient patch and the v3 router env are
      gone; the codebase is strictly **v4-only**. Permit2 flow is shared.
- [x] **Signal lock** — while a wallet transaction is in flight the swap card
      is frozen against new `NEW_DECISION` events (suppressed signals are
      counted and surfaced), preventing double-signing mid-confirmation.
- [x] Dynamic token/pair management (DEX-style picker + top-100 CoinGecko
      universe) and per-trade budget controls denominated in the pair's base
      token, re-checked at execution.

## ✅ Phase 3.5 — UX Refinements & Desktop [DONE]

- [x] **Plug & Play Configuration modal** — Test Key / Test Connection with
      spinner→green/red feedback, validate-before-save, Unichain networks in
      the RPC dropdown, and **RPC hot-reloading in the Rust engine** (~50 s
      re-check of `/api/rpc-config` — no restart after saving a link).
- [x] Desktop distribution (Tauri v2 shell, NSIS installer, sidecar staging,
      self-healing orchestrator spawn) + WalletConnect bridge inside the
      WebView.
- [x] Real market data in the UI: 24h % change and top-100 token prices via
      CoinGecko (honest `—` when a token has no market data).

---

## 🔜 Phase 4 — Real On-Chain Feed & Live Execution Pipeline [IN PROGRESS]

Goal: replace synthetic market data with live on-chain reads from the user's
validated RPC endpoint, keeping the mUSDC/mUSDT Unichain Sepolia playground as
the canonical test target.

- [x] **Real-provider swap data generation (2026-09-15)** — every provider
      path (Gemini, Ollama Cloud, OpenAI, Anthropic, DeepSeek, local Ollama
      and the mock fallback) emits an executable v4 swap card: the orchestrator
      intercepts each non-HOLD decision and builds the Universal Router
      calldata server-side (`withSwapData` → `getUniswapSwapData`), with
      `amountOutMinimum` anchored to a live V4Quoter quote through the user's
      RPC (synthetic band as fallback). LLM never emits calldata.
- [x] **RPC plug-in + hot-reload** — dashboard-validated provider links reach
      the engine live (`/api/rpc-config`, ~50 s re-check) and drive the V4Quoter
      min-out anchoring (chain-id-guarded candidates).
- [x] **Live Pool & Feed Synchronization (on-chain price feed):**
  - [x] **Uniswap v4 pool reads:** extract live `slot0` / `sqrtPriceX96` for
        the active v4 pool (PoolManager `getSlot0(poolId)`) via `poolPrice.ts` over the user's RPC — starting with the user-deployed mUSDC/mUSDT pool on Unichain Sepolia (fee 2500 / tick 25).
  - [x] **Price fallback chain:** transparent fallback chain (`pool` → `coingecko` ratio → `synthetic`).
  - [x] **Unified dashboard feed:** synchronize the header price monitor, the LLM prompt market context, and decision feed on the exact same live price, with explicit source labels (`pool` / `coingecko` / `synthetic`).
- [ ] **Real on-chain token balances:** replace synthetic balance checks with
        live ERC-20 `balanceOf` reads for base/quote tokens on the connected
        network (chain-aware budget bounds).
- [ ] **True USD notional budget** — express the per-trade cap in USD using
        live prices instead of base-token units on synthetic numbers.
- [ ] **End-to-end live swap verification:** execute testnet swaps driven by
        Gemini / Ollama Cloud signals on Unichain Sepolia (and Base testnet)
        with real pool prices end to end.
- [ ] Extra AppKit connectors inside the WebView (Coinbase Wallet, Safe,
      email/social embedded wallets).
- [ ] **Code signing (Azure Trusted Signing)** — remove the SmartScreen
      “Unknown publisher” warning.
- [ ] Containerization & cloud deploy (Docker / Vercel / Railway).

---

## 🧭 Product Direction (ordered)

1. **Session Keys (ERC-4337) — bounded autonomous execution.**
   The wallet becomes a smart account (Biconomy / ZeroDev / Privy / Safe). The
   user signs a **one-time permission policy** (e.g. “max 0.25 ETH, max 0.5%
   slippage, only WETH/USDC v4 pool, valid 24 h”). The agent generates an
   ephemeral session key, signs transactions in the background, and the chain
   **enforces the policy at contract level**. The user stays non-custodial
   while the agent gains true autonomy within limits.
2. **Uniswap v4 Custom Hook Integration Engine.**
   Developers plug custom v4 Hook contracts (MEV protection, dynamic fees,
   limit orders, custom order types) into the AI execution pipeline. The AI
   reads the hook ABI/proposal and suggests optimized parameters before
   executing. Positioning: turn TRusT-AI into the standard dev/test interface
   for the Uniswap ecosystem. (Foundation shipped: v4-only encoding, hook
   address + `getHookPermissions` validation live — see
   `docs/design/uniswap-routing-v3-v4-hooks.md`.)
3. **Custom models / fine-tuning — “bring your own model”.**
   Custom prompts, local endpoints, or user-trained models targeting their own
   trading strategy.
4. **Multi-chain & multi-DEX.**
   Arbitrum, Base, Polygon, Optimism; SushiSwap, Curve, PancakeSwap,
   aggregators (1inch).

## 💡 Future / Backlog

- Backtesting engine with historical on-chain data.
- Telegram/Discord real-time alerts.
- Multi-user dashboard (auth + per-wallet panels).
- Extra AppKit connectors (Coinbase, Safe, email/social embedded wallets).
- Docker / cloud deploy.

---

## Model in one line

```
[Phase 3: Co-Pilot] ──► [Phase 4: Live Feed] ──► [Next: Session Keys]
 1-Click Execution        Real on-chain data      Bounded Autonomy
 (Full user control)      (v4 pools + oracles)    (ERC-4337 policy)
```

## Why “Human-in-the-Loop” first (design rationale)

1. **Zero custody, zero legal risk.** The server never manages user private
   keys; the user keeps the final control (reads the thesis, signs with one
   click).
2. **BYOM.** Whatever model the user connects (OpenAI, Gemini, DeepSeek,
   Claude, Ollama Cloud or a local Ollama model) works out of the box — even
   fully offline/private with Ollama.
3. **Transparency = trust.** Every signal shows AI reasoning, confidence, MEV
   risk, gas, and the one-line route summary — no black box. The server, not
   the LLM, owns the calldata encoding.

## Docs map

| File | Audience | Language | Goes to git? |
|---|---|---|---|
| `README.md` (root) | Public | EN | ✅ |
| `AGENTS.md` (root) | Agents & devs | EN | ✅ |
| `docs/ROADMAP.md` | Public/contributors | EN | ✅ |
| `docs/SECURITY.md` | Devs/security review | EN | ✅ |
| `docs/reference/Uniswap-swap.md` | Devs | EN | ✅ |
| `docs/design/uniswap-routing-v3-v4-hooks.md` | Devs (design) | EN | ✅ |
| `docs/internal/roadmap-pt-BR.md` | Internal working notes | PT | ❌ (gitignored) |
| `docs/internal/README-pt-BR.md` | Internal original README | PT | ❌ (gitignored) |

When implementing a roadmap item: update this file, `AGENTS.md`, and keep the
“known issues” list (`AGENTS.md` §7) current.
