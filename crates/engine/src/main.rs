use chrono::Utc;
use dotenvy::dotenv;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info, warn};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarketTriggerPayload {
    pub block_number: u64,
    pub block_hash: String,
    pub pair: String,
    pub token_in: String,
    pub token_out: String,
    pub pool_address: String,
    pub current_price: f64,
    pub price_change_24h: f64,
    pub gas_price_gwei: f64,
    pub estimated_slippage_percent: f64,
    pub liquidity_depth_usd: f64,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EngineStatusResponse {
    pub status: String,
    pub decision: Option<serde_json::Value>,
    /// Pair the dashboard is currently monitoring (echoed by the orchestrator
    /// on every trigger response). "ALL" (or None) keeps the default set.
    #[serde(default)]
    pub monitored_pair: Option<String>,
    /// Phase 4 — source of the price the orchestrator used for this signal
    /// ("pool" = live v4 slot0, "coingecko" = market ratio, "synthetic" =
    /// engine placeholder). Informational; the engine loop is unchanged until
    /// the Rust-side live pipeline replaces the simulator.
    #[serde(default)]
    pub price_source: Option<String>,
}

// Token catalog shared by the simulator. USD prices are synthetic; they only
// give the simulator a base price per pair (usd(base)/usd(quote)). Keep in
// sync with TOKEN_DECIMALS in apps/server/src/uniswapApi.ts and the
// TOKEN_REGISTRY in apps/web/src/App.tsx.
//
// Per-network token catalog (Phase A — Unichain Sepolia playground):
// - Mainnet-addressed tokens: WETH, WBTC, USDC, LINK, UNI, DAI, LDO, AAVE
// - Unichain Sepolia mock tokens: mUSDT, mUSDC (deployed by user for testnet playground)
struct CatalogToken {
    symbol: &'static str,
    address: &'static str,
    usd_price: f64,
    #[allow(dead_code)]
    network: &'static str, // "mainnet" for mainnet-addressed tokens, "unichain-sepolia" for mock tokens
}

const TOKEN_CATALOG: &[CatalogToken] = &[
    // Mainnet-addressed tokens (used on Ethereum mainnet, Sepolia, and other chains)
    CatalogToken { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", usd_price: 3450.0, network: "mainnet" },
    CatalogToken { symbol: "WBTC", address: "0x2260fAc5e5542a773Aa44FbcFeDF7c193bc2C599", usd_price: 68200.0, network: "mainnet" },
    CatalogToken { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usd_price: 1.0, network: "mainnet" },
    CatalogToken { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", usd_price: 189.0, network: "mainnet" },
    CatalogToken { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", usd_price: 7.5, network: "mainnet" },
    CatalogToken { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", usd_price: 1.0, network: "mainnet" },
    CatalogToken { symbol: "LDO", address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", usd_price: 1.6, network: "mainnet" },
    CatalogToken { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", usd_price: 95.0, network: "mainnet" },
    // Unichain Sepolia mock tokens (Phase A playground)
    CatalogToken { symbol: "mUSDT", address: "0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06", usd_price: 1.0, network: "unichain-sepolia" },
    CatalogToken { symbol: "mUSDC", address: "0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860", usd_price: 1.0, network: "unichain-sepolia" },
];

// Resolves a "BASE/QUOTE" pair id (as sent by the dashboard) into the token
// addresses + synthetic base price used by the simulator. Returns None for
// unknown symbols, same-token pairs or malformed ids.
fn resolve_pair(pair_id: &str) -> Option<(String, String, String, f64)> {
    let (base, quote) = pair_id.split_once('/')?;
    if base == quote {
        return None;
    }
    let base_tok = TOKEN_CATALOG.iter().find(|t| t.symbol.to_lowercase() == base.to_lowercase())?;
    let quote_tok = TOKEN_CATALOG.iter().find(|t| t.symbol.to_lowercase() == quote.to_lowercase())?;
    let base_price = base_tok.usd_price / quote_tok.usd_price;
    Some((
        pair_id.to_string(),
        base_tok.address.to_string(),
        quote_tok.address.to_string(),
        base_price,
    ))
}

const DEFAULT_PAIR_IDS: &[&str] = &["WETH/USDC", "WETH/LINK", "WBTC/USDC"];

// Unichain Sepolia playground pair (user-deployed v4 pool — the legacy v3
// pool reference was removed with the v3 route, 2026-09-15). Both orderings are valid
// because the dashboard token picker can canonicalize the selection either way;
// the simulator accepts both and emits whichever the dashboard last asked for.
const PLAYGROUND_PAIR_IDS: &[&str] = &["mUSDC/mUSDT", "mUSDT/mUSDC"];

/// Build the ordered list of TS-Orchestrator trigger endpoints the engine
/// will try. Every returned URL ends with `/api/trigger` so the downstream
/// POST and the `/api/rpc-config` derivation (`trim_end_matches`) are
/// consistent. Duplicate URLs (e.g. when both `SERVER_URL` and
/// `SERVER_HOST` resolve to the same endpoint) are deduplicated while
/// preserving discovery order.
fn get_candidate_urls(server_port: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();

    let mut push = |url: String| {
        if !urls.contains(&url) {
            urls.push(url);
        }
    };

    // SERVER_URL is an explicit override provided by the user. It may be a full
    // trigger endpoint (`.../api/trigger`) or just the orchestrator base URL
    // (`http://host:port`). We normalise both to a trigger endpoint.
    if let Ok(env_url) = env::var("SERVER_URL") {
        let raw = env_url.trim();
        if !raw.is_empty() {
            if raw.ends_with("/api/trigger") {
                push(raw.to_string());
            } else {
                // Base URL without the trigger path — derive it.
                let base = raw.trim_end_matches('/');
                push(format!("{}/api/trigger", base));
            }
        }
    }

    // SERVER_HOST is a host-only override (no path). Always derive the
    // trigger endpoint from it.
    if let Ok(env_host) = env::var("SERVER_HOST") {
        let host = env_host.trim();
        if !host.is_empty() {
            push(format!("http://{}:{}/api/trigger", host, server_port));
        }
    }

    // Fallback discovery on the loopback interface, in order of preference.
    push(format!("http://127.0.0.1:{}/api/trigger", server_port));
    push(format!("http://localhost:{}/api/trigger", server_port));

    // Detect WSL default gateway host IP from /proc/net/route if running inside WSL
    if let Ok(route_content) = std::fs::read_to_string("/proc/net/route") {
        for line in route_content.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 3 && fields[1] == "00000000" {
                if let Ok(gw_hex) = u32::from_str_radix(fields[2], 16) {
                    if gw_hex != 0 {
                        let bytes = gw_hex.to_le_bytes();
                        let gw_ip = format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]);
                        push(format!("http://{}:{}/api/trigger", gw_ip, server_port));
                    }
                }
            }
        }
    }

    // Detect WSL default gateway host IP from /etc/resolv.conf
    if let Ok(resolv) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in resolv.lines() {
            if line.trim().starts_with("nameserver") {
                if let Some(ip) = line.split_whitespace().nth(1) {
                    push(format!("http://{}:{}/api/trigger", ip, server_port));
                }
            }
        }
    }

    urls
}

// Minimal JSON-RPC helper used to validate a user-provided RPC endpoint at
// startup (eth_chainId / eth_blockNumber). Not used to stream live data yet.
async fn rpc_call(
    client: &reqwest::Client,
    url: &str,
    method: &str,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": [] });
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP status {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(err) = value.get("error") {
        return Err(format!("JSON-RPC error: {}", err));
    }
    value.get("result").cloned().ok_or_else(|| "missing result field".to_string())
}

fn hex_to_u128(hex: &str) -> Option<u128> {
    u128::from_str_radix(hex.trim_start_matches("0x"), 16).ok()
}

// The dashboard's RPC plug-in (API Keys modal) stores the provider link in the
// orchestrator's memory; the engine pulls it here so users never need to edit
// .env. Returns (url, network) when the orchestrator reports a configured link.
async fn fetch_rpc_config_from_orchestrator(
    client: &reqwest::Client,
    candidates: &[String],
) -> Option<(String, String)> {
    for url in candidates {
        let base = url.trim_end_matches("/api/trigger");
        let cfg_url = format!("{}/api/rpc-config", base);
        match client.get(&cfg_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(cfg) => {
                        let configured = cfg.get("configured").and_then(|v| v.as_bool()).unwrap_or(false);
                        let cfg_url = cfg.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        if configured && !cfg_url.is_empty() {
                            let network = cfg
                                .get("network")
                                .and_then(|v| v.as_str())
                                .unwrap_or("sepolia")
                                .to_string();
                            return Some((cfg_url, network));
                        }
                        // Orchestrator reachable and answered: nothing configured.
                        return None;
                    }
                    Err(_) => return None,
                }
            }
            _ => {}
        }
    }
    None
}

// Validates a user-supplied RPC_HTTP_URL by asking the node for its chain id
// and latest block. This certifies that the link works; consuming live data
// from it is the Phase 4 pipeline.
async fn validate_rpc_endpoint(client: &reqwest::Client, url: &str, network_name: &str) {
    info!("🔗 LIVE RPC configured: {} (network: {}) — validating endpoint...", url, network_name);
    match rpc_call(client, url, "eth_chainId").await {
        Ok(chain) => {
            let chain_id = chain.as_str().and_then(hex_to_u128).unwrap_or(0);
            match rpc_call(client, url, "eth_blockNumber").await {
                Ok(block) => {
                    let block_num = block.as_str().and_then(hex_to_u128).unwrap_or(0);
                    info!(
                        "✅ RPC link validated — chainId: {} | latest block: #{} ({}). Market data still simulated until the Phase 4 live pipeline lands.",
                        chain_id, block_num, network_name
                    );
                }
                Err(e) => warn!("⚠️ RPC endpoint responded to eth_chainId but failed eth_blockNumber: {}", e),
            }
        }
        Err(e) => error!("❌ RPC endpoint rejected or unreachable ({}): {}", url, e),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load variables from the .env file
    let _ = dotenv();

    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .init();

    info!("🦀 [TRusT-AI Engine] Rust Execution Engine Started!");
    info!("⚡ Protocol: EVM / Ethereum Sepolia + Uniswap Liquidity Listener");

    let server_port = env::var("SERVER_PORT").unwrap_or_else(|_| "3001".to_string());
    let candidate_urls = get_candidate_urls(&server_port);

    // Fail fast at startup if the engine cannot resolve the playground pair
    // ids that the dashboard/UI expects. This catches catalog or symbol-case
    // regressions immediately (instead of silently falling back at runtime).
    for id in PLAYGROUND_PAIR_IDS {
        match resolve_pair(id) {
            Some(_) => {
                info!("🔍 Startup verified playground pair resolvable: \"{}\"", id);
            }
            None => {
                error!("🛑 Startup failed: playground pair \"{}\" cannot be resolved from the token catalog. The dashboard/UI will never receive playground signals until this is fixed.", id);
                return Err(format!("unresolvable playground pair: {}", id).into());
            }
        }
    }
    let mut active_url: Option<String> = None;

    info!("🔗 TS Orchestrator candidates: {:?}", candidate_urls);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;

    // RPC readiness: if a provider link is available (RPC_HTTP_URL env var, or
    // the dashboard's RPC plug-in — which wins over .env), detect LIVE mode and
    // validate the endpoint. Market data itself remains simulated until the
    // Phase 4 live pipeline lands. Links saved in the dashboard while the
    // engine is running are hot-applied (re-checked every ~50s in the loop
    // below) — no restart needed.
    let rpc_ws_url = env::var("RPC_WEBSOCKET_URL").ok().filter(|s| !s.trim().is_empty());
    let mut rpc_http_url = env::var("RPC_HTTP_URL").ok().filter(|s| !s.trim().is_empty());
    let mut network_name = env::var("NETWORK_NAME").unwrap_or_else(|_| "sepolia".to_string());

    if let Some((ui_url, ui_network)) =
        fetch_rpc_config_from_orchestrator(&client, &candidate_urls).await
    {
        info!("🎛️ RPC plug-in: provider link received from the dashboard UI (network: {}).", ui_network);
        rpc_http_url = Some(ui_url);
        network_name = ui_network;
    }

    // Separate, slower client for RPC endpoint validation probes (the main
    // `client` times out at 1s — fine for local orchestrator calls, too short
    // for a public RPC). Reused by the hot-reload check inside the loop.
    let rpc_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    // .env fallbacks so a link cleared in the dashboard reverts to the startup
    // configuration instead of silently dropping the .env RPC.
    let env_rpc_http_url = rpc_http_url.clone();
    let env_network_name = network_name.clone();
    let mut rpc_from_ui = false;

    match (&rpc_http_url, &rpc_ws_url) {
        (Some(url), ws) => {
            if let Some(ws_url) = ws {
                info!("🔌 WebSocket RPC configured ({}), but WS consumption is Phase 4 — using HTTP for validation.", ws_url);
            }
            validate_rpc_endpoint(&rpc_client, url, &network_name).await;
        }
        _ => {
            info!("🛰️ SIMULATOR MODE — no RPC link configured. Paste an Alchemy/Infura/QuickNode link in the dashboard (🔑 API Keys → RPC plug-in) or set RPC_HTTP_URL in .env — dashboard links are picked up live, no restart needed.");
        }
    }

    let mut block_number: u64 = 19_842_100;
    // Hot-reload cadence: re-check the dashboard RPC plug-in every 20 loops
    // (~50s at the 2500ms block cadence). Only re-validates when the link or
    // network actually changed so a quiet dashboard costs one cheap GET.
    let mut loop_count: u64 = 0;

    // The pairs the simulator streams by default (used when the dashboard is
    // in "ALL" monitor mode, or before the orchestrator reports a selection).
    //
    // When the playground (mock_pair) provider is active, the Unichain Sepolia
    // mUSDC/mUSDT pair is also included by default so the playground stays
    // testable without waiting for the orchestrator to pick it first.
    let default_pairs: Vec<(String, String, String, f64)> = {
        let mut out: Vec<(String, String, String, f64)> = DEFAULT_PAIR_IDS
            .iter()
            .filter_map(|id| resolve_pair(id))
            .collect();
        for id in PLAYGROUND_PAIR_IDS {
            if let Some(resolved) = resolve_pair(id) {
                if !out.iter().any(|(name, _, _, _)| name == &resolved.0) {
                    out.push(resolved);
                }
            }
        }
        out
    };

    // Last pair the dashboard asked the orchestrator to monitor, learned from
    // the monitored_pair field echoed in every /api/trigger response.
    let mut monitored_pair: Option<String> = None;

    info!("📡 Waiting for real-time block events...");

    loop {
        block_number += 1;
        loop_count += 1;
        let mut rng = rand::thread_rng();

        // RPC plug-in hot-reload: the dashboard's Configuration modal validates
        // and saves a provider link to the orchestrator's memory; the engine
        // picks it up here live (no restart), so paste → validate → save is the
        // whole flow. A cleared link reverts to the .env configuration.
        if loop_count % 20 == 0 {
            match fetch_rpc_config_from_orchestrator(&client, &candidate_urls).await {
                Some((ui_url, ui_network)) => {
                    if rpc_http_url.as_deref() != Some(ui_url.as_str()) || network_name != ui_network {
                        info!("🔁 RPC plug-in hot-reload: dashboard link changed (network: {}) — re-validating.", ui_network);
                        rpc_http_url = Some(ui_url);
                        network_name = ui_network;
                        rpc_from_ui = true;
                        if let Some(ref url) = rpc_http_url {
                            validate_rpc_endpoint(&rpc_client, url, &network_name).await;
                        }
                    }
                }
                None => {
                    if rpc_from_ui {
                        info!("🛰️ RPC link cleared in the dashboard — reverting to the .env configuration.");
                        rpc_http_url = env_rpc_http_url.clone();
                        network_name = env_network_name.clone();
                        rpc_from_ui = false;
                    }
                }
            }
        }

        // When the dashboard pinned a specific pair (e.g. WETH/USDC), simulate
        // only that pair so every trigger passes the orchestrator's filter and
        // the dashboard keeps receiving signals. "ALL" streams the defaults.
        //
        // IMPORTANT — pair id canonicalization:
        // The dashboard writes the selected pair as it picks it in the token
        // builder, which for the Unichain Sepolia playground can be either
        // "mUSDC/mUSDT" or "mUSDT/mUSDC" depending on the picking order. The
        // orchestrator echoes whatever it received as monitored_pair, and the
        // engine uses that exact string as its simulation target + as the label
        // on the trigger it POSTs to the orchestrator. The engine must accept
        // either order. "ALL" still keeps streaming the default set.
        let active_pairs: Vec<(String, String, String, f64)> = match monitored_pair {
            Some(ref pair) if pair != "ALL" => match resolve_pair(pair) {
                Some(resolved) => vec![resolved],
                None => {
                    warn!("⚠️ Requested pair \"{}\" is not in the token catalog; falling back to default pairs.", pair);
                    // Try the mirrored quote/base order too, in case the
                    // orchestrator/dashboard canonicalized it differently.
                    let swapped = {
                        let parts: Vec<&str> = pair.split('/').collect();
                        if parts.len() == 2 {
                            format!("{}/{}", parts[1], parts[0])
                        } else {
                            String::new()
                        }
                    };
                    if !swapped.is_empty() {
                        if let Some(resolved_swapped) = resolve_pair(&swapped) {
                            info!("🔄 Resolved monitored pair \"{}\" as mirrored pair \"{}\" for simulation.", pair, swapped);
                            vec![resolved_swapped]
                        } else {
                            default_pairs.clone()
                        }
                    } else {
                        default_pairs.clone()
                    }
                }
            },
            _ => default_pairs.clone(),
        };

        let idx = rng.gen_range(0..active_pairs.len());
        let (pair_name, token_in, token_out, base_price) = active_pairs[idx].clone();

        // Playground-specific pool address: the dashboard's swap card should
        // point at the real Unichain Sepolia test pool once the mock_pair
        // provider emits a signal for that pair.
        fn playground_pool_address_for(pair_id: &str) -> String {
            if pair_id.contains("mUSDC") && pair_id.contains("mUSDT") {
                "0x7a517eb3525cf73f408eb8e1c883441be7a5b857".to_string()
            } else {
                "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640".to_string()
            }
        }

        // Synthetic price fluctuation and high-precision real-time metrics
        let price_variance: f64 = rng.gen_range(-2.5..2.5);
        let current_price = base_price * (1.0 + (price_variance / 100.0));
        let gas_gwei: f64 = rng.gen_range(12.0..38.0);
        let slippage: f64 = rng.gen_range(0.05..0.45);
        let liquidity: f64 = rng.gen_range(1_200_000.0..8_500_000.0);
        let block_hash = format!("0x{:064x}", rng.gen::<u128>());

        info!(
            "📦 Block #{:<8} | Pair: {:<9} | Price: ${:<8.2} | Gas: {:<4.1} Gwei | Est. Slippage: {:<4.2}%",
            block_number, pair_name, current_price, gas_gwei, slippage
        );

        // Every N blocks or sharp movement, trigger an analysis for the LLM via the Orchestrator
        let is_anomaly = price_variance.abs() > 0.8 || block_number % 3 == 0;

        if is_anomaly {
            warn!(
                "🎯 [Market Trigger] Variation detected ({:+.2}%) on pair {}. Sending payload to AI...",
                price_variance, pair_name
            );

            let payload = MarketTriggerPayload {
                block_number,
                block_hash: block_hash.clone(),
                pair: pair_name.clone(),
                token_in: token_in.clone(),
                token_out: token_out.clone(),
                pool_address: playground_pool_address_for(&pair_name),
                current_price,
                price_change_24h: price_variance,
                gas_price_gwei: gas_gwei,
                estimated_slippage_percent: slippage,
                liquidity_depth_usd: liquidity,
                timestamp: Utc::now().to_rfc3339(),
            };

            let urls_to_try: Vec<String> = if let Some(ref current) = active_url {
                vec![current.clone()]
            } else {
                candidate_urls.clone()
            };

            let mut success = false;
            let mut last_err = String::new();
            for url in &urls_to_try {
                match client.post(url).json(&payload).send().await {
                    Ok(resp) => {
                        if resp.status().is_success() {
                            if active_url.as_ref() != Some(url) {
                                info!("🔗 Successfully connected to the TS Orchestrator at: {}", url);
                                active_url = Some(url.clone());
                            }
                            let result: Result<EngineStatusResponse, _> = resp.json().await;
                            match result {
                                Ok(data) => {
                                    info!("✅ TS Orchestrator confirmed the analysis. Decision: {:?}", data.status);
                                    // Learn which pair the dashboard is monitoring so the
                                    // simulator can stream exactly that pair.
                                    if let Some(ref mp) = data.monitored_pair {
                                        if monitored_pair.as_ref() != Some(mp) {
                                            info!("🎯 Dashboard is now monitoring pair: {} — updating simulation target.", mp);
                                            monitored_pair = Some(mp.clone());
                                        }
                                    }
                                }
                                Err(_) => {
                                    info!("✅ TS Orchestrator response received.");
                                }
                            }
                            success = true;
                            break;
                        } else {
                            warn!("⚠️ TS Orchestrator ({}) responded with status: {}", url, resp.status());
                        }
                    }
                    Err(err) => {
                        last_err = err.to_string();
                        if active_url.as_ref() == Some(url) {
                            active_url = None;
                        }
                    }
                }
            }

            if !success {
                error!("❌ Failed to connect to the TS Orchestrator (Error: {} | Tried: {:?}). Desktop mode: check the '[sidecar:trust-ai-server]' lines in the desktop console. Dev mode: run 'npm run dev:server' first.", last_err, candidate_urls);
            }
        }

        sleep(Duration::from_millis(2500)).await;
    }
}

