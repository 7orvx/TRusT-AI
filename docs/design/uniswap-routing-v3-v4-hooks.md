# Design: Route Selector (v3/v4), v4 Hook Plug-in & Unichain Sepolia Playground

> Status: **IMPLEMENTED (v4 live 2026-09-09) — see §10 for the implementation
> record, hard-won encoding lessons and the v3 removal checklist.** This
> document describes how TRusT-AI evolved from a fixed "Uniswap v3 (0.3%)"
> swap encoder into a route-aware terminal (v3 or v4 pool, optional v4 hook)
> with a real testnet pool on **Unichain Sepolia** as the live playground. It
> feeds roadmap item *"Uniswap v4 Custom Hook Integration Engine"* (see
> `docs/ROADMAP.md` → Product Direction #2). Keep it in English and in sync
> with `AGENTS.md` and the code as pieces land.

---

## 1. Goals

1. **Real testnet execution.** The user holds mock USDT/USDC on **Unichain
   Sepolia** and wants to create a pool there, list the pair in the dashboard,
   and execute *real* 1-click swaps against it (not just simulator data).
2. **Route selector.** The dashboard lets the user choose **Uniswap v3** or
   **Uniswap v4** for the swap route; the server encodes the matching calldata.
3. **v4 hook plug-in.** On a v4 route, the user can supply a **hook address**
   — i.e. route through a v4 pool whose `PoolKey` carries a custom hook
   (MEV protection, dynamic fees, limit orders…). This is the seed of the
   future Custom Hook Integration Engine.

Non-goals for v1: autonomous execution (ERC-4337), on-chain balance math in
USD, live price pipeline (all Phase 4, unchanged).

---

## 2. Current state (baseline, verified 2026-09-06)

- **Encoder** — `apps/server/src/uniswapApi.ts` builds **only** a v3
  `exactInputSingle` calldata: fixed `fee: 3000` (0.3%), zero-address
  `recipient`, router from `UNISWAP_V3_ROUTER` env (Sepolia default), and a
  `route_summary` label driven by `NETWORK_NAME`.
- **Client patch** — `apps/web/src/App.tsx` re-encodes calldata at execution
  time to replace the zero recipient with the connected account
  (`patchSwapRecipient`, ABI mirrored from the server). Any new server-side
  encoding must stay mirrored here or swaps break (AGENTS.md §7.1).
- **Token catalog is mainnet-only and mirrored in 3 places**
  (`TOKEN_CATALOG` Rust engine, `TOKEN_DECIMALS` server, `TOKEN_REGISTRY`
  web). The UI/labels claim Sepolia but the addresses are mainnet — AGENTS.md
  §7.6. A Unichain Sepolia pool with mock tokens makes this mismatch concrete.
- **Swap data only on the mock AI path** — real LLM decisions return no
  `uniswap_swap_data` yet (AGENTS.md §7.10 / roadmap Phase 4).
- **Engine** is a deterministic simulator; an RPC link is only *validated*
  (`eth_chainId`/`eth_blockNumber`), prices/liquidity remain synthetic until
  the Phase 4 live pipeline.
- **Wallet** — AppKit ↔ wagmi bridged (2026-09-06); the chain selector and
  swap execution read the shared wagmi store, so adding chains is additive.

---

## 3. Prerequisite: the Unichain Sepolia playground

Ordered so each step unblocks the next. All of this happens **before** route
selection work so v1 of the selector is tested against a real pool.

### 3.1 Chain definition + wallet support ✅ DONE
**Phase A completed 2026-09-06.** Added **Unichain Sepolia** to the wagmi/AppKit chain set in
`apps/web/src/wallet/config.ts` (chain ID `1301`, block explorer, native
currency) so the chain dropdown can switch the wallet to it and the server
label follows (`NETWORK_NAME=unichain-sepolia`). Same chain metadata is
usable by the viem client that builds/patches calldata.

### 3.2 Deploy/create the pool ✅ DONE
**Phase A completed 2026-09-06.** The user created a v3 pool for the mock USDT/USDC on Unichain Sepolia
(`univ3PoolFactory.createPool` → `initialize(sqrtPriceX96)` → add liquidity;
or just add liquidity to an existing pool). Recorded addresses:
- **Pool Address:** `0x7a517eb3525cf73f408eb8e1c883441be7a5b857`
- **NonfungiblePositionManager:** `0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075`
- **Fee Tier:** 3000 (0.3%)
- **Initial Liquidity:** ~104.956 mUSDC / 104.956 mUSDT

> ⚠️ The Unichain Sepolia router address needs to be confirmed from official
> Uniswap deployment docs before production use. The current code uses the
> Sepolia default; override via `UNISWAP_V3_ROUTER` env when targeting
> Unichain Sepolia.

### 3.3 Per-network token catalog (the key refactor) ✅ DONE
**Phase A completed 2026-09-06.** The single mainnet table became a **per-network** table keyed by
`NETWORK_NAME` (and matching `chainId`):

```
sepolia            → mainnet-addressed demo set (WETH, WBTC, USDC, LINK, UNI, DAI, LDO, AAVE)
unichain-sepolia   → mock USDT / mock USDC addresses the user deployed
```

All three mirrors (Rust `TOKEN_CATALOG`, server `TOKEN_DECIMALS`, web
`TOKEN_REGISTRY`) updated to this shape. The pair picker offers pairs
that exist on the selected network. The engine learns the dashboard
pair via `monitored_pair`; it now has the *network* so its
synthetic catalog lookups resolve to the right token set. This resolves the
AGENTS.md §7.6 mainnet-vs-Sepolia mismatch by making addresses follow the
selected network instead of lying about it.

### 3.4 Verify with a real swap — ready for testing
Wiring order for a first end-to-end manual swap on the playground:
1. Dashboard on `unichain-sepolia`, pair = mUSDT/mUSDC.
2. Server encodes v3 calldata against the Unichain Sepolia router with the
   mock token addresses (decimals resolved from the per-network catalog).
3. `patchSwapRecipient` runs; user signs via WalletConnect/MetaMask on
   **Unichain Sepolia**.
4. Tx confirmed on the testnet explorer.

Approvals caveat (unchanged from today): ERC20 input tokens need an approval
tx before the swap; only WETH-as-native is treated as payable value.

---

## 4. Route selector (v3 / v4)

### 4.1 Where the choice lives
Keep **server-side encoding** as the single source of truth: the dashboard
pushes the route choice through the existing `/api/settings` flow, and every
`uniswap_swap_data` is generated with it. The swap card *shows* the route
(already has `route_summary`); a per-signal route override is a v2 nicety,
not v1.

New settings fields (in-memory, matching the current settings pattern):
- `route.protocol: 'v3' | 'v4'`
- v3: `route.fee` (fee tier, e.g. `500 | 3000 | 10000`)
- v4: `route.tickSpacing`, `route.hooksAddress` (see §5), plus the fee tier

### 4.2 Server encoding split
`getUniswapSwapData(...)` branches on the active route:

- **v3** — today's path, fee no longer hardcoded to 3000.
- **v4** — Universal Router encoding (see `docs/reference/Uniswap-swap.md`,
  Smart Contracts → Path A): a `V4_SWAP` command whose payload contains
  `ExactInputSingleParams { poolKey, zeroForOne, amountIn, amountOutMinimum,
  hookData }` followed by the `SETTLE`/`TAKE` actions. This is a
  **multi-action command input**, so:
  - `to_address` = the v4 `UniversalRouter` on the active network;
  - `router_name` / `route_summary` report v4;
  - value handling and WETH-as-native logic stay as today;
  - the **settle step must credit the input token back to `msg.sender`
    semantics of the router** — exact command bytes verified against the
    chain's deployed router at implementation time.

### 4.3 Client patch must learn v4
`patchSwapRecipient` decodes + re-encodes v3 `exactInputSingle` today. For v4
the patch needs the **Universal Router ABI** (recipient appears in the
`TAKE`/`SETTLE` action params, not in a single tuple), so the mirroring rule
(AGENTS.md §7.1) becomes: every router ABI + patch pair stays in sync, and
execution aborts if the active route's patch cannot be built. Prefer
re-encoding the full v4 input on the client from a typed route object the
server echoes back (same pattern as v3 today).

### 4.4 Direction/decimals math is reused
The existing base/quote, BUY/SELL, per-token decimals and slippage
computation (AGENTS.md §6 + §7.2) is route-independent — keep it as the
shared front half; only the final calldata assembly differs per route.

---

## 5. v4 hook address plug-in

### 5.1 Semantics: the hook is part of the PoolKey
In v4 the hook address is **not** a standalone modifier — it is one of the
five `PoolKey` fields (`currency0`, `currency1`, `fee`, `tickSpacing`,
`hooks`). Routing "with a hook" therefore means: **swap through the pool
whose PoolKey includes that hook address**. The UI field is really
"hook-bearing pool address selector," and the pool must exist (or be
deployed) on the active network for the swap to succeed.

Implications for the design:
- The hook field is **v4-only** (v3 has no hooks). When protocol = v3 the
  field is hidden/ignored.
- Two tokens sort into `currency0 < currency1`; `zeroForOne` derives from the
  swap direction. The server must sort, the client must display sorted
  currencies in the summary, or signatures will be wrong.
- `hookData` bytes: v1 passes empty bytes; a follow-up lets the AI/hook
  propose hook payloads (the future Integration Engine).

### 5.2 Validation of a hook address
Before accepting a hook address for a route, run a static call to
`getHookPermissions(hook)` on the PoolManager to learn which lifecycle
functions the hook implements and whether its flags are compatible with the
swap path (AGENTS.md roadmap: MEV protection, dynamic fees…). Reject
incompatible flags with a clear error instead of a failed swap. `hooks =
0x0000…0000` (no hook) remains the default v4 route.

### 5.3 Hook registry (v1 minimal)
Ship an address input with optional "known hooks" presets per network rather
than a full ABI browser. The full ABI/proposal reading loop belongs to the
future Custom Hook Integration Engine.

---

## 6. Settings & UI changes (dashboard)

- **Route group** in the Risk & Execution panel (or the swap card): toggle
  **v3 / v4**; fee tier picker (v3: 0.05/0.3/1%; v4: fee + tick spacing);
  hook address field (v4 only) with a "no hook" default.
- **Network label** shows the real network everywhere it's used in the UI
  today (route summary, explorer links, TOKEN_REGISTRY picker) driven by the
  active chain + `NETWORK_NAME`.
- **Swap card** displays the concrete route (pool address / hook address) and
  keeps the existing budget cap + slippage re-checks before signing.
- New strings only in English; no layout regressions (AGENTS.md §7.7 width
  guards).

---

## 7. Suggested implementation phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **A. Playground** | ✅ DONE (2026-09-06) — Unichain Sepolia chain in wallet config; v3 + v4 mock USDT/USDC pools deployed by the user; per-network token catalog in all 3 mirrors; `NETWORK_NAME=unichain-sepolia` | Pools + tokens live on the playground network |
| **B. Route selector v3/v4** | ✅ DONE (2026-09-09) — settings fields; server encoder branch + v4 Universal Router assembly; **no v4 recipient patch needed** (UR `TAKE_ALL` → `msg.sender`); Permit2 approval flow | **First real v4 swap executed on-chain** (mUSDT→mUSDC, block 62118440) |
| **C. Hook plug-in** | Field + `getHookPermissions` validation wired; open: hook presets per network | Swap through a deployed hook-bearing v4 pool succeeds |
| **D. Real-provider swap data** | Open: wire the shared encoder into OpenAI/Anthropic/DeepSeek/Ollama decision paths (roadmap Phase 4 item). The mock/mock_pair paths are the working template | Real-LLM signals produce executable swap cards |
| **E. v3 removal** | Planned — see §10.2 | Route selector is v4-only; no v3 encoder/patch code remains |

---

## 8. Risks & open questions

1. **Address truth.** Confirm Unichain Sepolia's deployed Uniswap
   factory/router/Permit2 addresses from official docs before Phase A; do not
   reuse Sepolia defaults.
2. **Permit2 on v4.** v4 ERC20 flows route through Permit2; the current
   "approval tx first" UX must be extended for v4, and native-value handling
   re-verified per chain.
3. **Universal Router patch complexity.** Multi-action command inputs make the
   client-side recipient patch more involved than the v3 tuple; keep
   server/client ABI mirroring airtight or move patching fully client-side.
4. **`currency0/currency1` ordering + `zeroForOne`** — easy to get wrong and
   sign against the wrong pool; centralize it in the shared encoder half and
   unit-check with a quote call.
5. **Still synthetic prices.** Swaps will execute on the playground with
   simulator-derived amounts until the Phase 4 live price pipeline; the swap
   either reverts (bad slippage/price) or succeeds at pool price — that's the
   playground's job to surface.
6. **Dynamic-fee hooks** change pool semantics (fee not static); route summary
   must reflect that the fee is hook-controlled when a dynamic-fee hook is
   selected.

---

## 9. References

- `docs/reference/Uniswap-swap.md` — v4 Universal Router command encoding,
  PoolKey, hook lifecycle (`beforeSwap`/`afterSwap`,
  `getHookPermissions`).
- `docs/ROADMAP.md` — Product Direction #2 (v4 Custom Hook Integration
  Engine); Phase 4 open items (real-provider swap data, live pipeline).
- `AGENTS.md` — §5 runtime contracts, §6 conventions (three-place token
  catalog, recipient-patch mirroring), §7 known issues (#18 v4 encoding fix,
  #19 v3 deprecation).

---

## 10. Implementation record & lessons (2026-09-09)

### 10.1 What shipped — and the two bugs that mattered

The v4 route went live end-to-end on **2026-09-09**: first real 1-click swap
on Unichain Sepolia — **5.025 mUSDT → 5.027677 mUSDC, block 62118440**,
PoolManager `0x00B036B5…e62AC`, gas 136,382. The user's deployed v4 pool:
fee `2500` (0.25%), tickSpacing `25`, no hook, poolId
`0xa57deccf…62752` (the v3 playground pool 0.3%/60 lives on the same tokens).

Every earlier v4 revert — which the wallet masked as a generic gas/fee
error — traced to **ABI-encoding mistakes**, found by simulating the exact
calldata on-chain (sequencer RPCs hide revert reasons, so counterfactual
probes were the only signal):

1. **Swap params must be encoded as ONE struct.** The UR's v4 module decodes
   the `SWAP_EXACT_IN_SINGLE` action params with
   `abi.decode(params, (IV4Router.ExactInputSingleParams))`. Because the
   struct contains a dynamic member (`bytes hookData`),
   `abi.encode(theStruct)` emits an **offset word + tail**, which is NOT
   byte-identical to encoding the five fields positionally — the positional
   layout makes the decoder read a bogus tuple offset and revert. Same-family
   bug in the `V4Quoter.quoteExactInputSingle` call: the deployed lens takes a
   single `QuoteExactSingleParams` struct, not `(poolKey, bool, uint128,
   bytes)` positionally. **Rule for any future action/encoder: mirror how the
   Solidity side declares the parameter — if it's a struct, encode the
   struct, never its fields inline.**
2. **`amountOutMinimum` must come from the real pool, not the synthetic
   price.** The simulator prices mUSDC/mUSDT at 1.0 but the live pool trades
   at tick −31 ≈ 0.9969; a min-out band built from 1.0 reverted with
   `V4TooLittleReceived` on the BUY direction. The server now quotes the pool
   via `V4Quoter` (chain-id-guarded RPC candidate) and derives the band from
   the live quote; the synthetic price is only a fallback when the quoter is
   unreachable.

Also worth knowing (cost real debugging time):

- **Tick spacing is part of the PoolKey** — the pool was deployed with
  tickSpacing `25`, not the 60 default; a wrong value derives a different
  `poolId` and targets a nonexistent pool. Defaults now match the deployed
  pools (v4: fee 2500/tick 25; v3: fee 3000/tick 60).
- **The v4 `TAKE_ALL` sends output to `msg.sender`**, so no client-side
  recipient patch exists on the v4 path (contrast with v3's zero-address
  recipient + `patchSwapRecipient`).
- **Permit2 flow (v4 and Unichain v3):** token → Permit2 plain ERC20
  `approve`, then Permit2 → router `permit2.approve(token, router, amount,
  expiration)`; the shared client helper (`ensurePermit2Allowances`) checks
  both allowances first and only asks for missing approvals.
- **Unichain Sepolia's v3 router is SwapRouter02, which pulls ERC20 via
  Permit2** (`payOrPermit2Transfer`) — a plain `approve(router)` does nothing
  there. The server echoes `permit2_address` so the client can run the right
  flow.
- The deployed-era router interface uses `uint128 amountIn/amountOutMinimum`
  (values < 2¹²⁸ encode identically as `uint256`); current v4-periphery
  `main` adds a `minHopPriceX36` field — if Uniswap ever redeploys the UR,
  re-verify the struct layout.

### 10.2 v3 removal checklist — DONE (2026-09-15)

The legacy v3 route was removed (product direction is v4-only). Completed:

- [x] `apps/server/src/uniswapApi.ts` — the v3 branch (`UNISWAP_V3_SWAP_ROUTER_ABI`,
  `ROUTER_BY_NETWORK`, `UNISWAP_V3_ROUTER` env resolution) and the `v3` arm of
  `getUniswapSwapData`; `protocol` collapsed to `'v4'`.
- [x] `apps/server/src/index.ts` — `routeConfig.protocol` v3 leg + route
  selector settings validation removed (`routeProtocol` from old clients is
  accepted but ignored).
- [x] `apps/web/src/App.tsx` — the v3 route selector leg, `patchSwapRecipient`,
  `decodeSwapParams` (v3-only), the v3 ABI and the plain-ERC20-approve fallback
  branch in the execution path (Permit2 flow kept).
- [x] Docs — README §"Web3 Wallet & 1-Click Execution", AGENTS.md §4/§5/§7 v3
  references, `.env.example` `UNISWAP_V3_ROUTER` entry (now documents
  `UNISWAP_V4_ROUTER`).
- [x] Settings UI — the "Swap Route Protocol" v3/v4 toggle was replaced by a
  fixed v4 label; the v4 PoolKey/hook fields are always visible in the tab.

Kept (route-independent, reused by v4): the per-token decimals map, the
base/quote direction math and the Permit2/ERC-20 helpers.
