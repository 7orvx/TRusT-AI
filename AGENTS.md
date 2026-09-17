# AGENTS.md — TRusT-AI Developer / Agent Guide

Guidance for AI agents and humans working on this repository. Read this before
touching code so you don't get lost or introduce changes that break the
architecture or its conventions.

> **Language policy:** All code, comments, log messages, UI strings, commits,
> and docs are written in **English** (the PT-BR → EN translation pass is
> complete). Do not add Portuguese content to code or docs that go to git. The
> only Portuguese files are the internal working notes under `docs/internal/`
> (gitignored).

---

## 1. What this project is

**TRusT-AI** is a non-custodial, zero-storage (no database, no server-side key
retention) autonomous DeFi trading-agent platform. An AI "co-pilot" watches
market conditions, emits transparent BUY/SELL/HOLD signals with reasoning, and
lets the user execute route-encoded Uniswap swaps with **one click** from
their own wallet — **Uniswap v4 (Universal Router) is the primary and only
strategic route** (executed live on-chain); the legacy v3 path was removed on
2026-09-15 (see §7 #18/#19).

Current positioning (MVP): **human-in-the-loop signal + 1-click execution**.
Fully autonomous execution via ERC-4337 session keys is a roadmap item, not
implemented.

### High-level architecture

```
React Dashboard (apps/web, :5173)
   │  WebSocket ws://localhost:3001   REST POST /api/settings
   ▼
Node/TS Orchestrator + AI Gateway (apps/server, :3001)
   ▲  POST /api/trigger (HTTP)
   │
Rust Execution Engine (crates/engine)  ← synthetic trigger simulator (RPC validated at startup)
```

Flow: **Rust engine** emits synthetic market triggers → **TS server** applies
risk controls (emergency pause → pair filter → AI throttle), asks the selected
**LLM provider** for a structured JSON decision, optionally encodes **Uniswap
calldata**, and broadcasts the decision → **React dashboard** renders it live
and lets the user sign/execute the swap from their own wallet — injected
MetaMask/Rabby (browser, EIP-1193) or a WalletConnect mobile session opened
through the Reown AppKit modal (also how the desktop .exe connects).

---

## 2. Monorepo layout

Not an npm workspace — the root `package.json` only has convenience scripts
that shell into each app. The Rust side is a true Cargo workspace.

```
├── package.json                 # Root scripts: dev:server / dev:web / dev:engine / build:*
├── Cargo.toml                   # Cargo workspace → crates/engine
├── .env                         # Local env (gitignored); copy from .env.example
├── .env.example                 # Env template (aligned with code; invalid line removed)
├── README.md                    # Public overview (EN)
├── AGENTS.md                    # This file (EN)
├── docs/
│   ├── ROADMAP.md               # Structured product/engineering roadmap (EN, git-ready)
│   ├── SECURITY.md              # Key-storage threat model + dev-only caveats (EN)
│   ├── reference/Uniswap-swap.md    # Uniswap integration reference (EN)
│   └── internal/                # PT-BR working notes — GITIGNORED, not pushed
│       ├── roadmap-pt-BR.md     # Original messy roadmap/conversations
│       └── README-pt-BR.md      # Original PT-BR README
├── apps/
│   ├── server/                  # TypeScript orchestrator (NodeNext, ESM)
│   │   └── src/
│   │       ├── index.ts         # Express + WebSocket gateway, state, REST endpoints
│   │       ├── aiProvider.ts    # Multi-provider LLM gateway + mock fallback + prompt
│   │       └── uniswapApi.ts    # viem calldata encoding (Uniswap v4 Universal Router — v4-only since 2026-09-15)
│   ├── web/                     # React 18 + Vite dashboard (Vanilla CSS, no UI lib)
│   │   └── src/
│   │       ├── App.tsx          # Entire dashboard UI + WS client + swap execution
│   │       ├── main.tsx
│   │       ├── index.css        # Design tokens (CSS variables), glassmorphism
│   │       └── wallet/          # Wallet layer: AppKit modal + wagmi 2.x (single store)
│   │           ├── config.ts          # WagmiAdapter + createAppKit bridge, hooks, helpers
│   │           ├── WalletProviders.tsx  # Wagmi + React Query provider tree
│   │           ├── NetworkSelector.tsx  # Chain switcher (wagmi useSwitchChain)
│   │           └── priceFetcher.ts      # CoinGecko prices + viem on-chain reads
│   └── desktop/                 # Tauri v2 desktop shell (Windows .exe distribution)
│       ├── package.json         # @tauri-apps/cli + icon/build/dev scripts
│       └── src-tauri/
│           ├── tauri.conf.json  # NSIS installer config + sidecar declarations
│           ├── capabilities/    # Shell (sidecar spawn) permissions for the window
│           ├── binaries/        # GENERATED sidecar exes (server SEA exe + engine exe)
│           └── src/main.rs      # Spawns orchestrator + engine sidecars, kills on exit
└── crates/
    └── engine/                  # Rust execution engine
        └── src/main.rs          # Single-file simulator loop (see caveats)
```

---

## 3. Ports, scripts, and how to run

| Component | Dir | Port | Run |
|---|---|---|---|
| TS Orchestrator | `apps/server` | `3001` (env `SERVER_PORT`) | `npm run dev:server` (root) |
| React Dashboard | `apps/web` | `5173` | `npm run dev:web` (root) |
| Rust Engine | `crates/engine` | — | `npm run dev:engine` (root) or `cargo run` |
| Desktop Shell | `apps/desktop` | WebView → `3001` | `npm run dev:desktop` (root; stages sidecars first) |

Root scripts: `dev:server`, `dev:web`, `dev:engine`, `dev:desktop`,
`stage:desktop` (rebuilds + stages the desktop sidecars into the active Cargo
target dir; `dev:desktop` runs it automatically), `build:server`, `build:web`,
`build:engine` (`cargo build --release`), `build:desktop` (web → server SEA
exe → engine sidecar → Tauri NSIS installer).

Getting started:
1. `cp .env.example .env` and adjust. The server loads `.env` from two places
   (first hit wins per key): the **running executable's dir** — in desktop mode
   `stage:desktop` drops a fresh copy of the root `.env` next to the SEA exe
   so `NETWORK_NAME`/`UNISWAP_V4_ROUTER`/`LLM_PROVIDER` stay correct inside
   the app — and the **monorepo root** via `<cwd>/../../.env` (the classic
   `npm run dev:server` path).
2. Start server, then engine, then web. Dashboard shows "WS LIVE" only when
   server is up; server console shows engine triggers once it connects.
3. For local LLM testing, provider `mock` works with no key. `ollama` needs a
   local Ollama server; the rest need a user API key (typed in the UI and kept
   in `localStorage` under key `trust_ai_api_keys`).

No lockfiles are committed yet and there is **no git repository initialized**
(as of writing). Pre-launch checklist: ensure `.gitignore` excludes `.env`, `*.exe`
and build artifacts (`target/`, `node_modules/`), verify documentation alignment, and run `git init` + create initial tag `v0.1.0-beta`.

---

## 4. Environment variables (what code actually reads)

The server/engine read these. The README and `.env.example` are aligned with
this table (historically the README said `AI_PROVIDER`; the code reads
`LLM_PROVIDER` — never rename it back).

| Variable | Where | Default | Notes |
|---|---|---|---|
| `SERVER_PORT` | server, engine | `3001` | Engine targets `http://<host>:SERVER_PORT/api/trigger` |
| `LLM_PROVIDER` | server | `mock` | `mock \| openai \| anthropic \| deepseek \| gemini \| ollama_cloud \| ollama` |
| `AI_API_KEY` | server | `''` | Fallback key (UI-sent key takes precedence) |
| `OLLAMA_BASE_URL` | server | `http://localhost:11434` | Local Ollama server (keyless provider) |
| `OLLAMA_CLOUD_MODEL` | server | `gemma4:31b` | Model id for the `ollama_cloud` provider (https://ollama.com, `Authorization: Bearer` key from ollama.com/settings/keys) |
| `OLLAMA_MODEL` | server | `deepseek-r1:latest` | |
| `UNISWAP_V4_ROUTER` | server | per-network v4 Universal Router | Explicit override; otherwise resolved from `NETWORK_NAME` (`unichain-sepolia` → `0xf705…`, `unichain` → `0xef74…`, `ethereum` → `0x4c82…`). The only swap route — the legacy v3 path was removed (2026-09-15) |
| `DEFAULT_SLIPPAGE_BPS` | server | `50` | Initial max slippage |
| `SERVER_URL` / `SERVER_HOST` | engine | — | Optional overrides for orchestrator discovery |
| `NETWORK_NAME` | engine, server | `sepolia` | Display label; also drives the Uniswap route summary in `uniswapApi.ts` |
| `RPC_HTTP_URL`, `RPC_WEBSOCKET_URL` | engine, server | — | **Read + validated at startup** (`eth_chainId` / `eth_blockNumber`) → LIVE RPC mode. Used by orchestrator for live Uniswap v4 `slot0` pool prices & `V4Quoter`. A link set through dashboard **RPC plug-in** (`/api/rpc-config`) wins over env vars |
| `MAX_TRADE_AMOUNT_ETH` | server | `0.25` | Default per-signal trade budget, in base-token units of the selected pair (dashboard stores one cap per token symbol and pushes the active one; server clamps every AI decision to it) |
| `SERVER_BIND` | server | `0.0.0.0` | Host the orchestrator binds to (keeps the documented LAN-dev behavior). The desktop shell spawns the server with `SERVER_BIND=127.0.0.1` so the packaged app is only reachable from the user's machine; `TRUST_AI_DESKTOP=1` is also set by the shell (informational) |
| `PRIVATE_KEY`, `ENGINE_PORT` | — | — | Reserved/unused. `PRIVATE_KEY` is never used — TRusT-AI is non-custodial |

---

## 5. Runtime contracts (keep in sync when changing)

### Market trigger (Rust → `POST /api/trigger`, JSON body)
Defined as `MarketTrigger` in `apps/server/src/aiProvider.ts` and
`MarketTriggerPayload` in `crates/engine/src/main.rs` — **both must stay
identical**. Fields: `block_number`, `block_hash`, `pair`, `token_in`,
`token_out`, `pool_address`, `current_price`, `price_change_24h`,
`gas_price_gwei`, `estimated_slippage_percent`, `liquidity_depth_usd`,
`timestamp`.

### Server REST endpoints
- `GET /api/health` — status JSON for debugging.
- `POST /api/trigger` — engine push. Pipeline: emergency pause → pair filter
  (`selectedPair`) → AI throttle (`analysisIntervalMs`, default 15 s) →
  **live price resolution** (`getLivePairPrice` in `poolPrice.ts`: v4 pool
  `slot0` via the user's RPC — read through the **StateView lens**
  (`V4_STATE_VIEW_BY_NETWORK`; the PoolManager itself REVERTS direct
  `getSlot0(bytes32)` calls on several chains, e.g. Unichain Sepolia, and
  viem decodes multi-output calls positionally, so named-output reads
  silently fail) → CoinGecko ratio → synthetic, stamped as
  `price_source`; `trigger.current_price` is overwritten with the live value
  so the prompt, monitor card and feed share one number) →
  `generateAIDecision(trigger, provider, key, maxTradeAmountEth)` → WS
  broadcast `NEW_DECISION`. Response echoes `monitored_pair` + `price_source`.
- `POST /api/settings` — dashboard updates provider/apiKey/pause/slippage/
  pair/interval/`maxTradeAmount`/`rpcUrl`+`rpcProvider`+`rpcNetwork`/
  `v4Fee`/`v4TickSpacing`/`v4HooksAddress`/
`v4HookPermissions` (the v4-only route config — the legacy v3 leg was removed,
2026-09-15); state is
in-memory only. `maxTradeAmount` must be a finite number > 0 (400 otherwise).
  RPC fields set the in-memory `rpcConfig` (empty string clears it). Since
  2026-09-17 `rpcNetwork` is ALSO applied standalone (no `rpcUrl` required)
  into the in-memory `selectedNetwork` — the source of truth for the swap
  route label + calldata network (`resolveNetwork` in `uniswapApi.ts`) and the
  live-price network in `/api/trigger`. Priority: `selectedNetwork` → RPC
  link's network → `NETWORK_NAME` (sepolia still remaps to unichain-sepolia
  for v4 routes). Exposed via `/api/health` as `selectedNetwork`. Sharp edge:
  cross-module readers MUST use `getSelectedNetwork()` (index.ts) — the
  desktop SEA's esbuild CJS bundle snapshots re-assigned `let` imports at load
  time (a plain `import { selectedNetwork }` froze on 'sepolia' forever),
  while in-place-mutated objects (`rpcConfig`, `routeConfig`) are safe. The
  server logs `🎯 [Network] … set to <key>` on every applied push and
  `🎯 [Network] <pair> resolves to <net>` per trigger — if those lines are
  absent, the running binary predates this fix. 2026-09-17: on dashboard
  load the web client pushes the saved RPC link FIRST and the pair + its
  network SECOND — the server keeps whichever `rpcNetwork` lands last, and
  the old order let the link's stale stored network win (every route label
  read UNICHAIN-SEPOLIA again). Same date: the playground PoolKey (fee 2500 /
  tick 25 + hook) is applied ONLY to the mUSDC/mUSDT mock pair — real pairs
  route through the standard hookless fee 500 / tick 60 tier
  (`isMockPairTokens` in `uniswapApi.ts`), and the LLM prompt describes the
  route that will actually be built.
- `GET /api/rpc-config` — returns `{ configured, provider, url, network }` to
  the Rust engine so the UI-set RPC link needs no `.env` edit. Contains the
  keyed URL — do not log/broadcast it, and never expose this server publicly.

### WebSocket protocol (server → dashboard)
- `SYSTEM_INIT` — sent on connect with full current state.
- `NEW_DECISION` — payload `{ trigger, decision }`.
- `SETTINGS_UPDATED` — after `/api/settings`.
- `EMERGENCY_PAUSE_ACTIVE` — when a trigger arrives while paused.

### AI decision shape (`AIDecision`)
`action: 'BUY'|'SELL'|'HOLD'`, `confidence` (0–1), `reasoning`,
`suggested_amount_eth`, `max_slippage_bps`, `mev_risk_level`, `provider_used`,
`timestamp`, optional `tx_hash_simulated`, optional `uniswap_swap_data`
(`to_address`, `calldata`, `value_wei`, `route_summary`,
`estimated_gas_units`, `router_name`). Real providers must answer **strict
JSON** with this schema; the mock fallback generates it heuristically.

### AI provider architecture (`aiProvider.ts`)
Order of attempts, falling through to the next on failure:
1. `ollama` — local `/api/generate`, no key required.
2. `anthropic` — Messages API.
3. `openai`/`deepseek` — OpenAI-compatible chat completions.
4. `gemini` — Google `generateContent` API (`gemini-2.5-flash`, strict JSON
   via `responseMimeType`).
5. `ollama_cloud` — hosted Ollama API (`https://ollama.com/api/chat`, Bearer
   key, default model `gemma4:31b`).
6. **Mock engine** (always available) — heuristic rules on
   `price_change_24h`, gas, slippage, plus a **fake random tx hash** and
   Uniswap calldata when action ≠ HOLD.

Never regress the invariant: **whatever provider is selected, a valid
`AIDecision` is always returned** (mock is the safety net).

### Desktop shell + sidecar contract
The Tauri shell (`apps/desktop/src-tauri`) is the entry point for the packaged
Windows app. It spawns the Node/TS orchestrator and the Rust engine as sidecars,
hosts the dashboard in a WebView2 window, binds the server to `127.0.0.1`,
and kills both sidecars on exit. Two runtime contracts matter for desktop builds:

- The engine sidecar binary must be present in
  `apps/desktop/src-tauri/binaries/` with the platform-specific name before the
  Tauri build/run starts. For the current toolchain that name is
  `trust-ai-engine-x86_64-pc-windows-msvc.exe`. The build pipeline normally
  stages it (see the root build scripts and `AGENTS.md` §3), but a manual local
  build is:
  ```bash
  npm run build:engine
  cp "$(find E:/rust_target/release -name 'trust-ai-engine.exe' -type f | head -n 1)" \
     "apps/desktop/src-tauri/binaries/trust-ai-engine-x86_64-pc-windows-msvc.exe"
  ```
  (Windows dev: use the PowerShell `Copy-Item` equivalent — the source path
  depends on whether `CARGO_TARGET_DIR` is set; the repo's active config uses
  `E:\rust_target`.)
- The desktop shell's `trust-ai-desktop` binary must compile against the
  currently pinned `tauri-plugin-shell` ABI. Today that means the `main.rs`
  receiver loop uses `Option<CommandEvent>` semantics for the shell plugin's
  blocking receiver, moves an owned sidecar name into the drain thread, and
  consumes each `CommandChild` when shutting down children (`drain(..)` +
  `kill()`), rather than borrowing out of the live child list.
- **Dev-mode sidecar resolution (`tauri dev`):** the shell plugin resolves
  sidecars as `<active Cargo target dir>/debug/<plain-name>.exe` — no
  target-triple suffix — e.g. `E:\rust_target\debug\trust-ai-server.exe`. The
  triple-suffixed files under `src-tauri/binaries/` are only used by release
  bundling. `npm run dev:desktop` therefore stages fresh plain-named copies
  first (root `stage:desktop` → `scripts/stage-sidecars.mjs`): it rebuilds the
  server SEA exe and the engine, then copies both into the active Cargo target
  dir (`CARGO_TARGET_DIR` env, falling back to `apps/desktop/src-tauri/target`).
  If staging hits a file lock, close the running desktop app first — the
  sidecars execute exactly those files; zombie processes can be killed with
  `taskkill /F /IM trust-ai-server.exe` / `trust-ai-engine.exe`.
- The shell spawns the orchestrator with a self-healing retry (up to 3
  attempts): it waits for the server to actually accept connections on
  `127.0.0.1:3001` and respawns it if a stale process holding the port made it
  exit (EADDRINUSE). Sidecar spawn errors and process exits are printed to the
  desktop console (`[desktop] …` / `[sidecar:…] terminated: …` lines), so a
  missing/stale binary or a crash is visible instead of a silent dashboard.

---

## 6. Conventions & expectations

- **One big `App.tsx` today** — splitting components is welcome refactoring,
  but do not change behavior/state flow silently.
- **Strict Code Scope Guardrail:** Do not perform global refactorings or rename
  functions across modules without explicit permission. Keep changes local to
  the requested file(s).
- Server state is **in-memory globals** in `index.ts`; a restart resets
  everything. There is intentionally no database (zero-storage philosophy).
- **Wallet state is ONE shared store (wagmi), bridged to the AppKit modal.**
  `apps/web/src/wallet/config.ts` builds the wagmi config through the Reown
  `WagmiAdapter` (`@reown/appkit-adapter-wagmi`) and hands it to `createAppKit`;
  connections made in the AppKit modal (WalletConnect QR / mobile / desktop) and
  via an injected extension (wagmi `injected` connector) both land in the same
  store, so the header pill, network selector and swap path always reflect the
  real session. Do NOT regress this to a standalone AppKit (`createAppKit`
  without `adapters: [wagmiAdapter]`) — that is the exact bug that left the
  header stuck on "Connect Wallet"/"No chain" while the modal showed a
  connected wallet.
- **`wagmi` is pinned to the 2.x line** (2.19.5 / `@wagmi/core` 2.22.1) because
  Reown AppKit is only compatible with wagmi 2.x. Do not bump `wagmi`/`@wagmi/core`
  to 3.x without first confirming `@reown/appkit-adapter-wagmi` supports it.
- API keys live **only in browser `localStorage`** — never send them to a
  server for storage, never log them. They are plain text there (readable by
  any page script / device profile); the only non-browser copy is the active
  key the local orchestrator holds in memory while it calls an LLM provider.
  See `docs/SECURITY.md` for the threat model.
- **Per-signal trade budget (user-set cap):** denominated in the BASE token of
  the monitored pair (WETH for WETH/USDC, WBTC for WBTC/USDC), with one cap
  per token symbol persisted in `localStorage` (`trust_ai_budgets`; the legacy
  `trust_ai_max_trade_amount` value migrates to a WETH entry). The dashboard
  validates > 0 (and, for ETH/WETH bases with a connected wallet, < the ETH
  balance) and mirrors the active cap to the server, which clamps every
  `suggested_amount_eth` (mock + real-LLM sanitize, prompt constraint). The UI
  re-checks at execution. Swap direction is standard DEX — BUY pays the quote
  token and receives base, SELL pays the base token and receives quote — and
  amounts are sized in the pair's BASE token for both directions (the quote
  leg is derived from the trigger price). Cancel on a signal dismisses it locally
  (Undo available; next decision restores the swap card) — it never sends an
  on-chain cancellation.
- **RPC plug-in (Phase 4 readiness):** the Configuration modal composes
  provider links (Alchemy/Infura/QuickNode/custom) for Sepolia, Unichain
  Sepolia, Unichain or Ethereum Mainnet and probes them for real via
  `POST /api/validate` (eth_chainId + eth_blockNumber) before saving — a
  broken/rate-limited link is never persisted. Keys are validated the same way
  (a minimal real request per provider; keys are never logged). Saved links
  are pushed via `/api/settings` (server applies them to the swap routing
  immediately) and the Rust engine hot-reloads them every ~50s from
  `/api/rpc-config` — no restart needed.
- UI copy, code comments and logs are **English** (PT-BR → EN pass complete).
  Keep all new strings in English; PT-BR lives only under `docs/internal/`.
- Rust engine emits **synthetic triggers**: the engine validates a configured `RPC_HTTP_URL`
  at startup (LIVE RPC mode), while the Node/TS orchestrator resolves live Uniswap v4 `slot0` pool
  prices and CoinGecko ratios directly (`poolPrice.ts`), stamping decisions with live price source badges.
- Keep `MarketTrigger` JSON field names snake_case; don't rename without
  updating all three consumers (Rust, server, web `AIDecision` UI types).
- **Shared token catalog — mirrored in THREE places, keep in sync:**
  `TOKEN_CATALOG` (crates/engine/src/main.rs), `TOKEN_DECIMALS`
  (apps/server/src/uniswapApi.ts) and `TOKEN_REGISTRY` (apps/web/src/App.tsx)
  must contain the same symbols + mainnet addresses. Adding a token to the
  dashboard picker without adding it to the engine/server maps breaks either
  the pair resolution or the swap calldata decimals (`Unknown token decimals`
  error). **Per-chain resolution:** on Unichain Sepolia (1301) WETH/USDC map
  to the REAL testnet contracts (`TOKEN_ADDRESS_BY_CHAIN[1301]` in
  `uniswapApi.ts`, mirrored by `TESTNET_ADDRESS_BY_NETWORK` in `poolPrice.ts`;
  WETH = OP-Stack canonical `0x4200…0006`, USDC = official testnet faucet
  `0x31d0…768f` — no dollar peg). The engine keeps emitting mainnet
  addresses; the server translates. The web picker offers WETH/USDC under
  the Unichain Sepolia tab backed by the PUBLIC real-asset pool. Since 2026-09-11 the web picker also lists a **dynamic top-100
  CoinGecko universe** (`fetchTopTokens` in `priceFetcher.ts`) — those entries
  are price-only (quote side / view-only pairs); only `TOKEN_REGISTRY` tokens
  are offered as swap BASE, so the registry mirrors above still gate real
  execution. The Unichain Sepolia mock tokens (mUSDC/mUSDT) stay in the
  engine/server maps for the Force Test Swap playground but are intentionally
  **not selectable** in the web picker (no market data, price shows `—`).
- **Dynamic pair monitoring:** the dashboard can build any `BASE/QUOTE` pair
  from the registry (DEX-style picker). The orchestrator echoes its current
  `selectedPair` as `monitored_pair` in every `/api/trigger` response, and the
  Rust engine learns it to simulate exactly that pair (falling back to the
  default pairs on unknown ids). Presets/"ALL" still behave as before.
- Verify changes with the per-app typechecks: `cd apps/server && npx tsc
  --noEmit`, `cd apps/web && npx tsc --noEmit`, `cargo check` in
  `crates/engine`. There are no automated tests yet.

---

## 7. Known issues / sharp edges (do not "fix" blindly — flag & align first)

1. ✅ **Zero-address recipient issue — obsolete (2026-09-15).** The v3 path
   encoded `recipient: 0x000...000` and the dashboard patched it with the
   connected account (`patchSwapRecipient`). With the v3 route removed the v4
   Universal Router's `TAKE_ALL` sends the output to `msg.sender`, so no
   recipient patch exists or is needed. If a future encoder ever emits
   recipient-carrying calldata again, re-introduce a client-side patch — never
   send unpatched calldata to a real network.
2. ✅ **SELL path decimals — fixed.** `uniswapApi.ts` resolves per-token
   decimals (`TOKEN_DECIMALS` map, extended 2026-09-04 to UNI/DAI/LDO/AAVE,
   mirroring the shared token catalog) and encodes
   `amountIn`/`amountOutMinimum` with `parseUnits(…, decimals)` instead of
   hardcoding `parseEther`; the SELL path also divides by the trigger price
   (quote→base) when computing the expected output. Remaining limitation:
   `price_change_24h` / `current_price` still come from the simulator, so
   amounts are demo-quality until the engine reads real data — and tokens
   outside `TOKEN_DECIMALS` raise an explicit error.
3. ✅ **Docs/env drift — aligned.** README env block and `.env.example` now
   match the code: `LLM_PROVIDER` (not `AI_PROVIDER`), `OLLAMA_BASE_URL` (not
   `OLLAMA_HOST`). The invalid `[TEMPLATE]` first line — which had silently
   reappeared in `.env.example` — was removed again on 2026-09-04. Reserved
   variables (`PRIVATE_KEY`, `ENGINE_PORT`, `MAX_TRADE_AMOUNT_ETH`) are
   annotated in `.env.example` as Phase 4 / never-used.
4. ✅ **Phase A — Unichain Sepolia playground — completed 2026-09-06.**
   Added Unichain Sepolia to the wagmi config (chain ID 1301), per-network
   token catalog with mock USDT/USDC addresses in all three mirrors
   (Rust `TOKEN_CATALOG`, server `TOKEN_DECIMALS`, web `TOKEN_REGISTRY`),
   updated `.env.example` with Unichain Sepolia defaults. The dashboard can
   switch to Unichain Sepolia and select mUSDT/mUSDC pairs for testing
   swaps against the user-deployed v4 pool (pool id `0xa57deccf…` — see
   `routeConfig` in `apps/server/src/index.ts`; the earlier v3 pool reference
   `0x7a517eb3…` is obsolete since the v3 removal).
   NOTE 2026-09-11: the mock tokens were removed from the web picker's
   selectable list (the `TOKEN_REGISTRY` entries are kept — the server-side
   Force Test Swap flow still resolves them); pick them via the engine's
   monitored pair instead if a manual simulation run is needed.
5. **`price_change_24h` is misleading** — the engine fills it with an
   instantaneous random per-block variance, not a real 24 h change. The
   dashboard's *monitor card* is unaffected: since 2026-09-11 it shows the
   real CoinGecko 24h change (`getUsdChange24h`), but signal/log cards still
   render the synthetic `trigger.price_change_24h` until the Phase 4 live
   pipeline.
6. **Simulated tx hashes** are random hex strings; the "simulated Sepolia
   transaction" links in the UI point at hashes that never existed on-chain
   (unless the user actually executed a swap — only then is the hash real).
7. ✅ **UI overflow — fixed.** Long calldata/route content could push the
   layout wider than the viewport because the 2-column grid children had no
   `min-width: 0`. Fixed: `.main-grid` (min-width: 0 + responsive 1-col under
   1100px), forced word-break on calldata/route (`overflow-wrap: anywhere`),
   and a compacted swap button (no Tailwind — vanilla CSS/inline styles).
   When adding wide content to cards, keep these guards.
8. **RPC readiness — validated, live pipeline pending.** The engine now reads
   `RPC_HTTP_URL` / `RPC_WEBSOCKET_URL` / `NETWORK_NAME`. When a provider
   link is configured it validates the endpoint (`eth_chainId` +
   `eth_blockNumber`), logs LIVE RPC mode, and otherwise logs SIMULATOR MODE.
   Prices/liquidity/hashes are still synthetic until the Phase 4 pipeline;
   the validation only certifies that the pasted link works. AI providers are
   already link-ready: keys typed in the dashboard (`localStorage`) or
   `AI_API_KEY` are consumed by `aiProvider.ts` with mock fallback.
9. **Per-trade budget is per-base-token and still demo-grade.** The cap is
   denominated in the BASE token of the monitored pair (one cap per token
   symbol, `trust_ai_budgets`); amounts are sized in base units for both
   directions (BUY pays quote → receives base, SELL pays base → receives
   quote; the quote leg is derived from the trigger price) and the wallet
   balance bound only applies to ETH/WETH bases. The notional math is still
   synthetic (not USD) until Phase 4 derives real per-token prices and
   chain-aware ERC20 balances. The cap hard-stops the agent from ever
   proposing more than the user set.
10. ✅ **Real-provider signals now carry swap data — done (2026-09-15).**
    Every provider path (OpenAI/Anthropic/DeepSeek/Gemini/Ollama/Ollama Cloud
    and the mock fallback) routes its sanitized decision through
    `withSwapData()` in `aiProvider.ts`, which attaches server-built Uniswap
    v4 Universal Router calldata via `getUniswapSwapData` (live V4Quoter
    min-out anchoring through the user's RPC included). The LLM only decides
    action/amount/slippage — it NEVER emits calldata, so a hallucinated
    payload cannot reach the wallet. If calldata generation fails (unknown
    token decimals, unsupported network), the decision still broadcasts
    without a swap card — the "always a valid AIDecision" invariant holds.
    NOTE 2026-09-11: the dashboard no longer renders the raw calldata hex —
    the swap card shows only the one-line `Route:` summary (keep it that way
    unless the user asks; execution rewrites nothing in the encoded data — the
    UR sends the output to `msg.sender`).
11. **Keys are plain-text and the dev server binds `0.0.0.0`.** API keys are
    readable in `localStorage` by anything running on the page/device; the
    Express server listens on `0.0.0.0:3001` so on a LAN other machines can
    reach `/api/*` (including the keyed RPC URL in `/api/rpc-config`).
    Acceptable for local dev only — do not deploy this binding as-is (see
    `docs/SECURITY.md`). The **desktop shell spawns the server with
    `SERVER_BIND=127.0.0.1`**, closing that LAN exposure in the packaged app.
12. ✅ **Desktop shell (Tauri): wallet bridge via WalletConnect — mostly done.**
    The WebView2 window has no `window.ethereum`, so there is no injected
    MetaMask/Rabby inside it. Fixed on 2026-09-06: clicking Connect Wallet
    opens the Reown AppKit modal and the connection (WalletConnect QR / mobile
    deep link) is bridged into the shared wagmi store — the header pill,
    network selector and swap execution all work with the WalletConnect
    session (transactions are signed on the user's phone). Residual caveats:
    no *injected* extension inside the WebView (browser-based execution with
    MetaMask remains available at `http://localhost:3001`), and execution via
    WalletConnect needs the phone wallet to support the requested network/chain
    switch. See §6 "Wallet state".
13. **Desktop artifacts are unsigned → SmartScreen warns.** The open-source
    distribution route (GitHub Actions builds + `SHA256SUMS.txt`) means
    Windows shows an *Unknown publisher* prompt on first run. Code signing
    (Azure Trusted Signing) is planned; see `docs/SECURITY.md`. Sidecar
    binaries are named `trust-ai-server-x86_64-pc-windows-msvc.exe` /
    `trust-ai-engine-…` under `apps/desktop/src-tauri/binaries/` and are
    **regenerated by `npm run build:desktop`** — never edit them by hand.

14. ✅ **Dashboard selected-pair persistence — fixed (2026-09-16).** The pair
    selection now persists in localStorage (`trust_ai_selected_pair`) and is
    re-pushed to the orchestrator on load (once per value — see the §8 entry
    on the echo/ping-pong guards). Reloads and desktop restarts keep the
    user's pair instead of reverting to defaults.

15. **Synthetic mUSDT/mUSDC signal is a test-only convenience, not a real market signal.**
    The new `mock_pair` provider emits a deterministic BUY every 3rd streamed
    block for that pair so the user can exercise a real swap against the deployed
    v4 pool without waiting for a real price move. It is intentionally limited to
    the mUSDC/mUSDT pair and to a small budget, and the UI labels the provider
    clearly so it is not confused with the heuristic mock or a real LLM. This is    only useful until real-provider swap data and the v4 pool/hook-slot UI are in
    place.

15. **Network selector dropdown can mask other panels.** The chain dropdown is
    anchored to the header trigger, so on dense layouts it can cover the live
    price/info panels; the fix is to keep the downstream panels out of the
    dropdown's hit area or to reposition the dropdown (z-index / fixed
    positioning).
16. **Desktop: orchestrator sidecar could silently fail to start — fixed**
    (2026-09-08): `tauri dev` resolves sidecars as plain-named exes in the
    active Cargo target dir, and the server SEA exe used to be staged there
    only by hand — a stale/missing copy (or a leftover process holding port
    3001, which makes the fresh server exit with EADDRINUSE) produced endless
    engine `Failed to connect to the TS Orchestrator` errors and a dashboard
    without data, with the engine wrongly suggesting `npm run dev:server`.
    `npm run dev:desktop` now stages fresh sidecars automatically
    (`stage:desktop`) and the shell retries + health-checks the orchestrator
    spawn; the engine error message now points at the desktop console.
17. ✅ **Unichain Sepolia swap execution — fixed (2026-09-08): router + approval.**
    The playground swaps were landing as `Transfer*` / `0 ETH` txs with empty
    logs because `uniswapApi.ts` always encoded the Sepolia SwapRouter02
    (`0xE592…`) — an address with **no code on Unichain Sepolia** — so the
    wallet sent the (otherwise correct) `exactInputSingle` calldata to a
    non-contract and the data was silently ignored. The router is now resolved
    per `NETWORK_NAME` (Unichain Sepolia → `0xd1aae39293221b77b0c71fbd6dcb7ea29bb5b166`,
    per the official Uniswap deployment docs), and the dashboard added the
    missing **ERC-20 approval step**: before the swap it reads `allowance` on
    the input token and, when short, submits + waits for an `approve(router,
    amountIn)` tx, then sends the swap. The swap card also gained a chain
    mismatch guard (wrong network → abort with a message), a network-aware
    explorer link, and the hardcoded “SEPOLIA” card header now reflects the
    actual route label. Related fix: the desktop SEA server used to resolve
    `.env` as `<cwd>/../../.env` and `cwd` is the Cargo target dir when the
    Tauri shell spawns it — so desktop runs silently defaulted to
    `NETWORK_NAME=sepolia` (and the Sepolia router). The server now loads
    `.env` from its own exe dir first, and `stage:desktop` copies the root
    `.env` there on every `dev:desktop` (see §3).
18. ✅ **Uniswap v4 route is LIVE (2026-09-09) — struct-encoding root cause
    found & fixed.** First real 1-click v4 swap executed on Unichain Sepolia
    (5.025 mUSDT → 5.027677 mUSDC, block 62118440, PoolManager
    `0x00B036B5…e62AC`). Every earlier v4 revert traced to two ABI-encoding
    bugs, both fixed and proven by simulating the exact calldata on-chain:
    (a) the UR's v4 module decodes `SWAP_EXACT_IN_SINGLE` params as ONE struct
    (`ExactInputSingleParams` has a dynamic `bytes hookData` member, so
    `abi.encode(struct)` = offset+tail ≠ the fields encoded positionally);
    (b) the deployed `V4Quoter.quoteExactInputSingle` likewise takes a single
    `QuoteExactSingleParams` struct. `amountOutMinimum` is anchored to a live
    V4Quoter quote (the real pool trades at tick −31 ≈ 0.9969 vs the synthetic
    1.0 — the old band reverted with `V4TooLittleReceived` on BUY); the quoter
    RPC candidate is chain-id-guarded. Details:
    `docs/design/uniswap-routing-v3-v4-hooks.md` §10.
19. ✅ **v3 route: REMOVED (2026-09-15) — the codebase is v4-only.** The v3
    branch in `uniswapApi.ts` (SwapRouter02 encoding, `ROUTER_BY_NETWORK`,
    `UNISWAP_V3_ROUTER` env), the v3 leg of `routeConfig`/settings, the route
    selector UI and the client-side `patchSwapRecipient`/`decodeSwapParams` +
    plain-approve fallback are gone (checklist in
    `docs/design/uniswap-routing-v3-v4-hooks.md` §10.2 — completed). All swaps
    encode a Universal Router v4 command with Permit2 approvals. Older clients
    that still POST `routeProtocol: 'v3'` are accepted but ignored.
20. ✅ **Mock/route config leakage + stale-signal card — fixed (2026-09-17).**
    Two compounding bugs made a LINK/USDC (or WETH/UNI on Base/Polygon) card
    render a mUSDT/mUSDC playground route: (a) the playground PoolKey from
    the Route panel (fee 2500 / tick 25) leaked into EVERY pair's calldata
    and route label — it is now scoped to the mock pair (`isMockPairTokens`
    in `uniswapApi.ts`); real pairs route through the standard hookless
    fee 500 / tick 60 tier; (b) the swap card kept the LAST decision ever
    received, even after the user changed pair — NEW_DECISION payloads whose
    `trigger.pair` does not match the selected pair now go feed-only
    (`signalPairMatchesSelection` in `App.tsx`), and the mock pair is only
    coherent when explicitly selected. The card's Route line strips the
    static `(<NETWORK>)` mention from the summary — the picker's
    `exec on <network>` is the network shown (the summary's label describes
    where calldata was BUILT, which can trail the UI pick by one signal).
21. ✅ **Boot network race on dashboard load — fixed (2026-09-17).** The load
    effect pushed pair+network, then the saved RPC link — whose stale stored
    network (e.g. `sepolia`) overwrote `selectedNetwork` server-side (last
    write wins). Fee/tick DID update while the label stayed UNICHAIN-SEPOLIA,
    which looked like a stale binary. Push order inverted: RPC link first,
    pair + its network last.
22. ✅ **Slot0 reader silently dead — fixed (2026-09-17).** Two compounding
    bugs starved the live pool price: (a) the PoolManager on Unichain Sepolia
    reverts direct `getSlot0(bytes32)` calls — the supported read path is the
    v4 StateView lens (`0xc199f1072a74d4e905aba1a84d9a45e2546b6222` on 1301;
    per-chain table `V4_STATE_VIEW_BY_NETWORK` in `poolPrice.ts`, addresses
    from the official deployments doc), now primary with a PoolManager
    fallback; (b) viem's `decodeFunctionResult` returns multi-output tuples
    POSITIONALLY — the old named-output read was always `undefined`, failing
    the `> 0` check and degrading EVERY pool read (even the mock pair) to
    CoinGecko/synthetic. Also fixed: the slot0→price conversion ignored
    decimals (raw WETH/USDC ratio was off by 1e12).
23. ✅ **Public real-asset test pools — done (2026-09-17).** Anyone with
    faucet ETH can run a REAL end-to-end swap without deploying mock
    contracts: the hookless WETH/USDC pool on Unichain Sepolia (fee 500 /
    tick 10, poolId `0x71fba4ef…41422`) was chain-discovered (PoolManager
    Initialize events → StateView liquidity → live V4Quoter quote > 0) and
    is cataloged in `PUBLIC_POOL_KEY_BY_NETWORK` (`uniswapApi.ts`). Routed
    by PAIR+NETWORK — never by the Route-panel config — and takes PoolKey
    precedence between the mock playground and the generic 0.05% tier. The
    testnet USDC is a faucet token with NO dollar peg: monitor/route show
    the real pool price as-is. The mUSDC/mUSDT playground stays intact.
    Discovery/verification tooling lives in `apps/server/scripts/`
    (discover-v4-pools / identify-v4-pools / check-public-pool /
    verify-public-route) and can be re-run on any chain by swapping the RPC
    + PoolManager constants — including Sepolia Ethereum, should the
    Unichain pool ever be too thin for a test trade.
---

## 8. Roadmap context

Public/structured: **`docs/ROADMAP.md`** (EN, git-ready). Internal PT-BR
working notes (original roadmap, product conversations): `docs/internal/`
(gitignored — never push them).

- ✅ **Desktop distribution (.exe) — done** (2026-09-05): Tauri v2 shell
  (`apps/desktop`) spawns the orchestrator (esbuild + Node SEA standalone exe)
  and Rust engine as sidecars, hosts the dashboard in a WebView2 window, binds
  the server to `127.0.0.1`, and kills both sidecars on close. NSIS installer
  + `SHA256SUMS.txt` are produced by `.github/workflows/release-desktop.yml`
  (tag `v*` or manual). Known limits: no *injected* MetaMask inside the WebView
  (WalletConnect/AppKit bridge covers it — done 2026-09-06), unsigned binaries
  trigger SmartScreen (Azure Trusted Signing planned).
- ✅ **Desktop dev flow: sidecar staging + self-healing orchestrator spawn —
  done** (2026-09-08): `npm run dev:desktop` rebuilds and stages the server SEA
  exe + engine into the active Cargo target dir (plain names — the way the
  shell plugin resolves sidecars in dev), and the shell retries the
  orchestrator spawn and verifies it comes up on `127.0.0.1:3001` — no more
  silent "no data" sessions from stale binaries or a zombie holding port 3001
  (see §5 and §7 #16).
- ✅ **Wallet state sync (AppKit ↔ wagmi) — done** (2026-09-06): the AppKit
  modal is now bridged into the wagmi store via `@reown/appkit-adapter-wagmi`
  (wagmi aligned to 2.x), so connections — injected extension OR WalletConnect
  QR/mobile — update the header pill, the network selector and the swap
  execution provider from one source of truth. See §6 and §7 #12.

- ✅ Phase 1–3 (per `docs/ROADMAP.md`): monorepo, multi-AI provider w/ mock
  fallback, Web3 wallet connect, Uniswap calldata generation, 1-click execution.
- 🔜 Phase 4 (not done): real RPC config in the Rust engine, containerization
  (Docker/Vercel/Railway).
- ✅ **Dynamic token/pair management — done** (2026-09-04): DEX-style
  base/quote token picker (`TOKEN_REGISTRY`, searchable modal) replaces the
  fixed 3-pair grid; engine simulates the dashboard-chosen pair via the
  `monitored_pair` echo; decimals map extended to UNI/DAI/LDO/AAVE.
- ✅ **Signal cancel + per-trade budget + keys/RPC review — done**
  (2026-09-04): Cancel dismisses a signal (Undo; never an on-chain cancel);
  the user-set budget caps every decision server-side and is re-checked
  at execution; keys modal copy is honest about plain-text localStorage with
  show/hide + clear; the RPC plug-in lets users set the provider link from
  the UI (`/api/rpc-config`) without editing `.env`.
- ✅ **Budget denominated by the pair's base token — done** (2026-09-04): one
  cap per token symbol (`trust_ai_budgets`), dynamic (WETH)/(WBTC)/(USDC)
  labels, and the **swap direction fixed** — BUY pays the quote token and
  receives the base token; SELL pays base and receives quote (amounts in base
  units; quote leg from the trigger price).
- ✅ **Network selector stacking fix — done** (open): the chain dropdown now
  uses fixed positioning anchored to the header trigger so it can overlay other
  panels; pair-builder token picker and the Credentials popover keep their
  existing z-index ordering.
- 🔜 Short follow-ups: generate `uniswap_swap_data` in the real-provider
    paths; true USD notional + on-chain token balances (Phase 4); live data
    pipeline.
- ✅ **mUSDC/mUSDT UI preset + selected-pair re-push — done** (2026-09-06):
  the dashboard now includes a preset for the user-deployed Unichain Sepolia
  test pair and re-pushes the selected pair to the orchestrator on load so the
  engine can simulate it immediately after restart.
- ✅ **Synthetic playground signal for mUSDC/mUSDT — done** (2026-09-06):
  a new `mock_pair` provider emits a deterministic BUY every 3rd streamed block
  for that pair so the user can exercise a real swap against the deployed v4
  pool (0x7a517eb3525cf73f408eb8e1c883441be7a5b857) without waiting for a real
  price move. UI labels the provider as “Mock Pair (mUSDC/mUSDT)”, the server
  forces a faster default analysis interval for it, and the logs make the
  synthetic decision obvious. This is a test-only convenience path; real-provider
  swap-data generation (roadmap) and the v4 pool/hook-slot UI come next.
- ✅ **Uniswap v4 route executed end-to-end — done** (2026-09-09): route
  selector + v4 Universal Router encoding live; first real on-chain v4 swap on
  Unichain Sepolia (block 62118440). Root cause of the earlier reverts was
  struct-vs-positional ABI encoding (§7 #18). The legacy v3 route was
  **removed on 2026-09-15** (§7 #19).
- ✅ **v3 route removal — done** (2026-09-15): SwapRouter02 encoding,
  `UNISWAP_V3_ROUTER` env, the v3/v4 route selector (UI + server) and the
  client-side recipient patch are gone; the dashboard Route tab is v4-only and
  the execution path uses the shared Permit2 flow for every swap. §10.2
  checklist in `docs/design/uniswap-routing-v3-v4-hooks.md` completed.
- ✅ **Signal lock during wallet transactions — done** (2026-09-15): clicking
  Confirm Swap acquires a signal lock (`swapInFlightRef` + `isSwapInFlight`)
  that freezes the swap card against incoming `NEW_DECISION` events until the
  tx is confirmed or rejected in the wallet (released in the execution
  handler's `finally`, so every exit path unlocks). Suppressed decisions still
  land in the feed and are counted — the card shows a "N newer signals
  arrived" notice after release. Prevents signing a stale/double signal while
  the wallet popup is open.
- ✅ **Dashboard real market data + DEX pair selector — done** (2026-09-11):
  the AI Signal card now uses a DEX-style [Base ▾] ⇅ [Quote ▾] selector
  (preset dropdown removed; Confirm Swap renders only on BUY/SELL), the
  monitor card shows the real CoinGecko 24h change (batched into the existing
  60s fetch — `getUsdChange24h`), price displays no longer fall back to
  invented demo numbers (honest `—`), the token picker lists the top ~100
  tokens by market cap with live prices (base side restricted to
  `TOKEN_REGISTRY` tokens), mUSDC/mUSDT left the selectable list (the Force
  Test Swap button keeps the playground), and the raw calldata box was
  removed from the swap card (the `Route:` summary stays).
- ✅ **L2 v4 routes + multichain token catalog — done** (2026-09-16): the v4
  contract maps (`V4_ROUTER_BY_NETWORK`, `V4_QUOTER_BY_NETWORK`,
  `V4_POOL_MANAGER_BY_NETWORK`, `CHAIN_ID_BY_NETWORK`, public RPC fallbacks)
  now cover **Arbitrum One (42161), Base (8453) and Polygon PoS (137)** —
  addresses taken from the official Uniswap deployments table (Universal
  Router 2.1.1 rows) and mirrored into `poolPrice.ts`. A per-chain token
  catalog (`TOKEN_ADDRESS_BY_CHAIN` in `uniswapApi.ts`, source: the official
  Uniswap Token List — mainnet rows cross-checked against the existing
  catalog) resolves the trigger's mainnet-addressed tokens into the target
  chain's contracts; on real-value L2s the mapping is **strict** (unmapped
  token → the decision streams without a swap card, never calldata with wrong
  addresses). Deliberate catalog gaps (USDT not in the official list on
  Arbitrum/Base; WBTC/LDO absent on Base/Polygon) reject with a clear error.
  On the web side the token picker now carries the REAL per-token chain data
  (server relay `/api/coingecko/coins/list?include_platform=true`, cached 6 h):
  network filter chips match tokens actually deployed on the chain and badges
  only render for app-supported chains. The Rust engine remains untouched —
  the trigger payload and its mainnet-addressed catalog are unchanged.
- ✅ **Real-provider swap data — done** (2026-09-15): every AI provider path
  (real LLMs + mock fallback) now emits the executable v4 swap card. The
  orchestrator intercepts each non-HOLD decision and builds the Universal
  Router calldata server-side (`withSwapData` → `getUniswapSwapData`), with
  `amountOutMinimum` anchored to a live V4Quoter quote over the user's
  configured RPC (synthetic band as fallback). The LLM decides
  action/amount/slippage; the server owns the encoding — hallucinated
  calldata can never reach the wallet.
- ✅ **Unified pair picker + network selection — done** (2026-09-16): the
  header network dropdown was REMOVED; network selection lives in the pair
  picker (minimal icon dropdown — Ethereum/Arbitrum/Base/Polygon/Unichain/
  Unichain Sepolia tabs). Picking a token under a tab sets the pair's
  EXECUTION chain and pushes it via `/api/settings` (`rpcNetwork`), so the
  swap route follows the pair. mUSDC/mUSDT are selectable again under the
  Unichain Sepolia tab as the real playground pair. The token catalog is
  CURATED (~10 executable tokens per network — `CHAIN_TOKEN_COVERAGE` in
  `apps/web/src/pairNetworks.ts` mirrors the server's
  `TOKEN_ADDRESS_BY_CHAIN`), with the dynamic top-100 capped at 10 entries
  per tab on the quote side. Monitor-card and picker prices share ONE source
  (`getUsdPriceMap` over registry + dynamic symbols) — no selector-vs-monitor
  divergence. Since 2026-09-17 the picker's network badges follow the active
  tab (registry tokens show the tab's chain badge — e.g. Base under the Base
  tab — instead of always Ethereum; on 'ALL' registry tokens keep the mainnet
  badge), the quick pills are filtered by the tab's coverage and canonicalize
  ETH→WETH (wrapped symbols match the catalog), and the modal subtitle names
  the network being browsed. `pickNetworkForPair` canonicalizes ETH→WETH /
  BTC→WBTC before the coverage lookup so native-alias quotes still resolve the
  pair's default chain.  The Unichain/Unichain Sepolia chain badge borrows the
  official UNI unicorn logo (TrustWallet asset) until an official chain asset
  exists — `CHAIN_LOGOS` in `apps/web/src/wallet/NetworkSelector.tsx`. Since
  2026-09-17 the pair's network survives a server/desktop restart: the load
  push sends the pair's network key (`rpcNetwork`) together with the pair, and
  the server applies it standalone into `selectedNetwork` — signal cards and
  calldata now reflect the pair's real chain (previously every route label
  fell back to `NETWORK_NAME` → UNICHAIN-SEPOLIA).
- ✅ **Pair echo ping-pong + ghost WS reconnect — fixed** (2026-09-16): the
  server broadcasts `SETTINGS_UPDATED` with `pairChanged` (true only when the
  request actually mutated the pair — single-writer) and `changedBy` (the
  pushing client's instance id); clients apply a pair echo ONLY when
  `pairChanged === true` AND the echo did not originate from themselves
  (two dashboards — desktop WebView + browser tab — can no longer fight).
  The web WS effect had a reconnect LEAK: cleanup closed the socket but the
  late `onclose` still scheduled a reconnect on the dead closure — ghost
  sockets received `SYSTEM_INIT` with the old pair and silently reverted the
  user's selection. Fixed with a `disposed` flag; the pair ref is now also
  updated synchronously at click time and the pair persists in
  localStorage (`trust_ai_selected_pair`).
- ✅ **Client RPC hygiene — done** (2026-09-16): browser-side reads use only
  CORS-verified public endpoints (`*.publicnode.com`, verified one by one —
  llamarpc/rpc.sepolia.org send no CORS; official Arbitrum endpoint 429s
  under polling). Paid Alchemy keys are SERVER-side material and are never
  injected into the web build (`getRpcUrlForChain` hard-disables them).
  viem client retry is disabled (`retryCount: 0`) and a per-chain circuit
  breaker (60s cooldown after 2 transport failures) turns endpoint outages
  into one quiet debug line instead of a 3k-error console storm. The
  live-data loop reads ERC-20 balances ONLY for tokens whose catalog chain
  matches the wallet chain (mainnet addresses against Arbitrum RPC were a
  guaranteed-error factory) at a 30s cadence.
- ✅ **Desktop dev flow serves a FRESH web build — done** (2026-09-16):
  `stage:desktop` (and therefore `npm run dev:desktop`) now runs
  `npm run build:web` BEFORE staging sidecars — the orchestrator serves the
  dashboard from `apps/web/dist`, so without this step every UI fix was
  invisible in the desktop app (stale 2026-09-15 build shipped for a whole
  session). The web build invocation uses `cmd.exe /c npm ...` on Windows
  (without `/c` the cmd opens interactively and hangs staging).
- ✅ **Route/pair coherence + multichain route defaults — done (2026-09-17):**
  the playground PoolKey (fee 2500/tick 25) is scoped to the mUSDC/mUSDT mock
  pair; real pairs route through the standard hookless fee 500/tick 60 v4
  tier (live V4Quoter min-out anchoring included); signals for a pair other
  than the selected one go feed-only so the swap card never mixes pairs; and
  the dashboard pushes the saved RPC link BEFORE the pair's network on load
  so `selectedNetwork` always ends on the pair's chain. The card's Route line
  drops the static network mention (`exec on <network>` from the picker).
- ✅ **Public real-asset test pool + StateView price feed — done (2026-09-17):**
  WETH/USDC on Unichain Sepolia is executable against the PUBLIC hookless v4
  pool (fee 500 / tick 10, poolId `0x71fba4ef…41422` — chain-verified with a
  live V4Quoter quote), WETH/USDC maps to real testnet contracts, and the
  live slot0 reader works again (StateView lens + positional decode +
  decimal-aware conversion — see §7 #22). The mUSDC/mUSDT playground remains
  first-class. Reusable on-chain discovery scripts in `apps/server/scripts/`.
- 🔜 **Phase 4 — live on-chain feed (first slice landed, 2026-09-15):**
  `apps/server/src/poolPrice.ts` reads the REAL v4 pool price (`getSlot0` on
  the PoolManager, poolId derived from the pair's PoolKey) through the user's
  validated RPC, with a transparent fallback chain — pool → CoinGecko
  base/quote ratio → engine synthetic — and a source label (`pool` /
  `coingecko` / `synthetic`). The orchestrator resolves it before the LLM call
  (`💰 [Live Price]` log), overwrites `trigger.current_price` with the live
  value, stamps `decision.price_source`, and echoes `price_source` in the
  `/api/trigger` response. The monitor card shows a `◉ LIVE POOL` / `◈ MARKET`
  badge (synthetic shows no badge). The mUSDC/mUSDT playground (fee 2500 /
  tick 25) is a first-class target. Next slices: real `sqrtPriceX96`-derived
  liquidity/gas in the trigger, engine-side block streaming, ERC-20 balance
  reads, USD notional budget.

- 🧭 Product direction: session keys (ERC-4337) for bounded autonomous
  execution, multi-chain, more DEXs/aggregators.
- 🔮 Future Module: **Uniswap v4 Custom Hook Integration Engine** — letting
  developers plug custom v4 Hook contracts (MEV protection, dynamic fees,
  custom order types) into the AI execution pipeline.

When implementing a roadmap item, update the roadmap/README and keep the
"known issues" list current.
