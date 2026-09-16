# 🔐 Security & Key Handling

TRusT-AI is **non-custodial and zero-storage by design**: there is no database,
no account system, and the server never holds a user's private key or stores
API keys. This document describes where secrets actually live, what is exposed,
and the accepted risks of the current (dev) deployment.

## Where secrets live today

| Secret | Storage | Lifetime | Notes |
|---|---|---|---|
| LLM provider API key (OpenAI/DeepSeek/Anthropic/Ollama) | Browser `localStorage` (`trust_ai_api_keys`) | Until cleared by the user | Sent to the **local** orchestrator only while a decision is generated; held in server memory, never persisted |
| RPC provider link (Alchemy/Infura/QuickNode) | Browser `localStorage` (`trust_ai_rpc`) + orchestrator memory (`rpcConfig`) | Until cleared / server restart | Pulled by the Rust engine at startup via `GET /api/rpc-config` |
| Wallet private key | **Never** | — | Keys never leave the user's wallet; swaps are signed per transaction in MetaMask/Rabby (browser) or in the phone wallet through the WalletConnect session (AppKit modal, incl. the desktop .exe WebView) |
| `PRIVATE_KEY` env var | Not read by any code | — | Reserved; the platform is non-custodial |

## Honest threat model for `localStorage`

`localStorage` is **plain text**. Anything that can read it:

- any JavaScript running on the page origin (e.g. an XSS or a compromised
  dependency), and
- anyone with physical/logical access to the device or browser profile.

Therefore:

- Enter keys **only on your own development machine**; avoid shared/public
  computers and browser profiles.
- Treat stored keys as sensitive even though they never leave your browser
  except to the local orchestrator: **rotate/revoke** them if you suspect a
  leak.
- The dashboard modal includes Show/Hide and **Clear stored keys** for this
  purpose. Clearing the UI keys also pushes an empty key to the orchestrator
  so the active in-memory key is dropped.
- API keys are never logged by the server and never broadcast over the
  WebSocket feed.

## Dev-only caveats (do not deploy as-is)

- **`0.0.0.0` binding:** the Express orchestrator listens on `0.0.0.0:3001`
  so the Rust engine can reach it from WSL. On a LAN, other machines can call
  `/api/*` — including `GET /api/rpc-config`, which returns the **keyed** RPC
  URL when configured, and `POST /api/settings`, which can switch the provider
  or pause the agent. Acceptable for local development only.
  Before any non-local deployment: bind to `127.0.0.1`, add an auth token, or
  put the API behind a private network.
- **No TLS in dev:** keys travel from the browser to the server over plain
  `http://localhost`. Local-only traffic; any network exposure requires HTTPS.
- **RPC plug-in scope:** today the engine only *validates* the UI-provided
  link at startup (`eth_chainId` / `eth_blockNumber`); market data remains
  simulated. The endpoint URL (with its embedded provider key) is served to
  the engine over localhost — keep the orchestrator reachable only from
  trusted hosts.

## Future hardening (roadmap)

- Optional **encrypted at rest** for localStorage keys using WebCrypto with a
  user passphrase (defense against local file reads, not against page-level
  XSS).
- **Session Keys (ERC-4337)**: replace per-tx signing with a policy-enforced
  session key so the agent can execute within limits **on-chain** — see
  `docs/ROADMAP.md`.
- Auth + per-user scoping when the dashboard becomes multi-user.

## Report

This is a demo-grade codebase. If you plan to run it with real funds or real
keys, review the points above first — the same applies to any third-party
provider (Alchemy/Infura/QuickNode) policy you paste in.
