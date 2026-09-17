// Price fetcher for the TRusT-AI dashboard.
//
// Uses CoinGecko API as the PRIMARY source for UI display prices.
// This works for ANY token pair dynamically — no hardcoded pool addresses needed.
//
// On-chain pool reads are kept only for potential swap execution path.
//
// Architecture:
//   - UI display prices: CoinGecko API (fast, works for any token, cached 60s)
//   - Swap execution: On-chain pool reads (via RPC, when needed)
//
// This separation keeps the UI simple and responsive while leaving the
// complexity of on-chain routing for the actual transaction execution.

import { type Address, createPublicClient, http, parseUnits, formatUnits, getAddress } from 'viem';
import { sepolia, mainnet, arbitrum, base, polygon } from 'viem/chains';
import { getRpcUrlForChain } from './config';

// ---------------------------------------------------------------------------
// Chain configs (public clients are created per-chain so we can switch).
// ---------------------------------------------------------------------------
const CHAINS = { sepolia, mainnet, arbitrum, base, polygon } as const;
type SupportedChain = typeof CHAINS[keyof typeof CHAINS];

const CHAIN_BY_ID: Record<number, SupportedChain> = {
  [sepolia.id]: sepolia,
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [polygon.id]: polygon,
};

// ---------------------------------------------------------------------------
// Shared token catalog (mainnet addresses — used for balance reads).
// ---------------------------------------------------------------------------
export interface TokenInfo {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  color: string;
  logoURI?: string;
}

export const TOKEN_LOGOS: Record<string, string> = {
  WETH: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png',
  ETH: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  WBTC: 'https://assets.coingecko.com/coins/images/7598/large/wrapped_bitcoin_wbtc.png',
  BTC: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
  USDC: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png',
  USDT: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png',
  LINK: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png',
  UNI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png',
  DAI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png',
  LDO: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32/logo.png',
  AAVE: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/logo.png',
  mUSDC: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png',
  mUSDT: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png',
};

export const TOKENS: Record<string, TokenInfo> = {
  WETH: { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address, decimals: 18, color: '#627eea' },
  WBTC: { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2260FAC5e5542a773Aa44fBCfeDf7C193bc2C599' as Address, decimals: 8, color: '#f7931a' },
  USDC: { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address, decimals: 6, color: '#2775ca' },
  USDT: { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address, decimals: 6, color: '#26a17b' },
  mUSDC: { symbol: 'mUSDC', name: 'Mock USDC', address: '0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860' as Address, decimals: 6, color: '#4ecdc4' },
  // mUSDT/mUSDC addresses must mirror crates/engine TOKEN_CATALOG and server
  // TOKEN_BY_SYMBOL exactly (same checksummed strings) — do not re-case them.
  mUSDT: { symbol: 'mUSDT', name: 'Mock USDT', address: '0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06' as Address, decimals: 6, color: '#ffb703' },
  LINK: { symbol: 'LINK', name: 'Chainlink', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' as Address, decimals: 18, color: '#2a5ada' },
  UNI: { symbol: 'UNI', name: 'Uniswap', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as Address, decimals: 18, color: '#ff007a' },
  DAI: { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address, decimals: 18, color: '#f5ac37' },
  LDO: { symbol: 'LDO', name: 'Lido DAO', address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' as Address, decimals: 18, color: '#00a3ff' },
  AAVE: { symbol: 'AAVE', name: 'Aave', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address, decimals: 18, color: '#b6509e' },
};

// ---------------------------------------------------------------------------
// CoinGecko API — PRIMARY price source for UI display.
// Works for ANY token dynamically without hardcoded addresses.
// ---------------------------------------------------------------------------

const COINGECKO_IDS: Record<string, string> = {
  WETH: 'ethereum',
  ETH: 'ethereum',
  WBTC: 'bitcoin',
  BTC: 'bitcoin',
  LINK: 'chainlink',
  UNI: 'uniswap',
  DAI: 'dai',
  LDO: 'lido-dao',
  AAVE: 'aave',
  USDC: 'usd-coin',
  USDT: 'tether',
  SOL: 'solana',
  PEPE: 'pepe',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  INJ: 'injective-protocol',
  ATOM: 'cosmos',
  DOT: 'polkadot',
  APT: 'aptos',
};

// Both CoinGecko calls go through the LOCAL orchestrator relay
// (apps/server GET /api/coingecko/*). The browser cannot call api.coingecko.com
// directly — the free API sends no Access-Control-Allow-Origin for localhost
// origins (CORS block seen in the console). The server has no origin
// restriction, so it proxies the request. Falls back gracefully when the
// orchestrator is down (prices show simulated values).
const COINGECKO_RELAY_BASE = 'http://localhost:3001/api/coingecko';

// ---------------------------------------------------------------------------
// Token → chain mapping (real chainId per dynamic picker token).
// Presentation only — swap routing never reads these values; the server
// resolves routes from its own per-network contract maps.
// ---------------------------------------------------------------------------

// CoinGecko platform keys → EVM chain ids (keys verified against the
// /coins/list?include_platform=true payload).
const PLATFORM_TO_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  'arbitrum-one': 42161,
  base: 8453,
  'polygon-pos': 137,
  optimism: 10,
  unichain: 130,
};

// gecko id → EVERY supported EVM chain the token is deployed on (mainnet
// first when present, mirroring PLATFORM_TO_CHAIN_ID order). Filled by
// loadTokenChainMap below; the first entry is the display/badge chain.
const chainsByGeckoId = new Map<string, number[]>();

// Dynamic (top-100) symbol → USD price, filled by fetchTopTokens. The SINGLE
// source both the picker rows and the monitor card read — guarantees the
// price shown while SELECTING a pair equals the price on the monitor card.
const dynamicSymbolUsd = new Map<string, number>();
// Dynamic symbol → CoinGecko id (lets simple/price lookups cover top-100
// tokens that are not in the static COINGECKO_IDS map).
const dynamicSymbolGeckoId = new Map<string, string>();

let chainMapLoaded = false;
let chainMapAttempts = 0;
async function loadTokenChainMap(): Promise<void> {
  if (chainMapLoaded || chainMapAttempts >= 3) return;
  chainMapAttempts++;
  try {
    const res = await fetch(`${COINGECKO_RELAY_BASE}/coins/list?include_platform=true`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rows = (await res.json()) as Array<{ id?: string; platforms?: Record<string, string> }>;
    for (const row of rows) {
      if (!row.id || !row.platforms) continue;
      const chains: number[] = [];
      for (const platform of Object.keys(PLATFORM_TO_CHAIN_ID)) {
        const contract = row.platforms[platform];
        if (contract && contract.length > 0) chains.push(PLATFORM_TO_CHAIN_ID[platform]);
      }
      if (chains.length > 0) chainsByGeckoId.set(row.id, chains);
    }
    chainMapLoaded = true;
    console.log(`[priceFetcher] token chain map loaded (${chainsByGeckoId.size} ids)`);
  } catch (err) {
    console.warn('CoinGecko coins/list fetch failed:', err);
    if (chainMapAttempts < 3) setTimeout(() => { void loadTokenChainMap(); }, 30_000);
  }
}
// Warm the chain map on page load (non-blocking; retried up to 3×).
void loadTokenChainMap();

// Cache with 60-second TTL to respect CoinGecko rate limits (free tier: 10-50 calls/min).
let priceCache: Record<string, number> | null = null;
// Real 24h % change (USD) per CoinGecko id, refreshed alongside the prices.
export let change24hCache: Record<string, number> | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000;

/** CoinGecko IDs to fetch in a single batched request. */
const COINGECKO_BATCH_IDS = [
  'bitcoin', 'ethereum', 'chainlink', 'uniswap', 'dai',
  'lido-dao', 'aave', 'usd-coin', 'tether', 'solana',
  'pepe', 'dogecoin', 'avalanche-2', 'matic-network',
  'arbitrum', 'optimism', 'injective-protocol', 'cosmos',
  'polkadot', 'aptos'
].join(',');

/**
 * Fetches real-time spot prices from CoinGecko's free API.
 * Returns a map of our symbol → USD price.
 */
async function fetchCoinGeckoPrices(): Promise<Record<string, number>> {
  try {
    const url = `${COINGECKO_RELAY_BASE}/simple/price?ids=${encodeURIComponent(COINGECKO_BATCH_IDS)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      console.warn('CoinGecko API error:', res.status, res.statusText);
      return {};
    }

    const data = await res.json() as Record<string, Record<string, number>>;
    const prices: Record<string, number> = {};
    const changes: Record<string, number> = {};

    // Map CoinGecko response back to our symbols
    for (const [id, entry] of Object.entries(data)) {
      if (typeof entry.usd === 'number') {
        prices[id] = entry.usd;
      }
      if (typeof entry.usd_24h_change === 'number') {
        changes[id] = entry.usd_24h_change;
      }
    }
    change24hCache = changes;

    // Stablecoins are always $1
    prices.USDC = 1;
    prices.USDT = 1;
    prices.DAI = 1;

    return prices;
  } catch (err) {
    console.warn('CoinGecko fetch error:', err);
    return {};
  }
}

/**
 * Returns cached CoinGecko prices, refreshing if older than CACHE_TTL.
 */
async function getCachedPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  if (priceCache && now - lastFetchTime < CACHE_TTL) {
    return priceCache;
  }

  priceCache = await fetchCoinGeckoPrices();
  lastFetchTime = now;
  return priceCache;
}

/**
 * One-batch USD price map for an arbitrary symbol list — the unified price
 * source for the monitor card (and anything else outside the picker).
 * Resolution order: dynamic top-100 row (identical to what the picker shows)
 * → shared simple/price cache via the symbol's gecko id → stablecoin $1.
 * Symbols with NO real data are OMITTED (the UI shows '—') — simulated
 * prices are never invented here, so the monitor can't diverge from the
 * selector or display invented numbers.
 */
export async function getUsdPriceMap(symbols: string[]): Promise<Record<string, number>> {
  const prices = await getCachedPrices();
  const out: Record<string, number> = {};
  for (const s of symbols) {
    const dynamic = dynamicSymbolUsd.get(s);
    if (typeof dynamic === 'number' && dynamic > 0) {
      out[s] = dynamic;
      continue;
    }
    const gid = dynamicSymbolGeckoId.get(s) ?? COINGECKO_IDS[s];
    const cached = gid ? prices[gid] : undefined;
    if (typeof cached === 'number' && cached > 0) {
      out[s] = cached;
      continue;
    }
    if (s === 'USDC' || s === 'USDT' || s === 'DAI' || s === 'mUSDC' || s === 'mUSDT') {
      out[s] = 1;
    }
  }
  return out;
}

/**
 * Returns the real 24h % change for a token symbol (CoinGecko, USD-denominated),
 * or null when no market data exists (e.g. testnet-only mock tokens).
 * Reads the cache filled by getUsdPriceFromApi — call after prices are fetched.
 */
export function getUsdChange24h(symbol: string): number | null {
  if (!change24hCache) return null;
  const geckoId = COINGECKO_IDS[symbol];
  if (!geckoId) return null;
  const change = change24hCache[geckoId];
  return typeof change === 'number' ? change : null;
}

export interface TopToken {
  symbol: string;
  name: string;
  usd: number;
  change24h: number | null;
  /** Hex color for the picker avatar (registry tokens); falls back to neutral. */
  color?: string;
  /** Contract address on active/main chain (if available) */
  address?: string;
  /** Primary chain id (first entry of chains) — badge/display use. */
  chainId?: number;
  /** EVERY supported EVM chain the token is deployed on (mainnet first). */
  chains?: number[];
  /** Token logo image URL (from CoinGecko / Uniswap token list) */
  logoURI?: string;
  /** Decimals */
  decimals?: number;
  /** 24h Trading Volume in USD */
  totalVolume?: number;
}

/**
 * Helper to format a token contract address into a clean truncated snippet (0x5fc5...d168).
 */
export function formatTruncatedAddress(address?: string): string {
  if (!address || address.length < 10) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Fetches the top ~100 tokens by market cap in ONE CoinGecko call
 * (symbol, name, price, 24h change, logo image, volume). Powers the dynamic token picker.
 */
export async function fetchTopTokens(limit = 100): Promise<TopToken[]> {
  try {
    const url = `${COINGECKO_RELAY_BASE}/coins/markets?per_page=${limit}`;
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn('CoinGecko markets API error:', res.status, res.statusText);
      return [];
    }
    const rows = await res.json() as Array<{
      id?: string;
      symbol?: string;
      name?: string;
      image?: string;
      current_price?: number;
      price_change_percentage_24h?: number | null;
      total_volume?: number | null;
    }>;
    return rows
      .filter((r) => r.symbol && typeof r.current_price === 'number')
      .map((r) => {
        const sym = (r.symbol as string).toUpperCase();
        const registryMatch = TOKENS[sym];
        const chains = r.id ? chainsByGeckoId.get(r.id) : undefined;
        // Register the dynamic price + gecko id so getUsdPriceMap (monitor
        // card) serves the EXACT same number this row displays.
        if (r.id) {
          dynamicSymbolUsd.set(sym, r.current_price as number);
          dynamicSymbolGeckoId.set(sym, r.id);
        }
        return {
          symbol: sym,
          name: registryMatch?.name ?? r.name ?? sym,
          usd: r.current_price as number,
          change24h: typeof r.price_change_percentage_24h === 'number' ? r.price_change_percentage_24h : null,
          logoURI: TOKEN_LOGOS[sym] || r.image,
          totalVolume: typeof r.total_volume === 'number' ? r.total_volume : undefined,
          address: registryMatch?.address,
          color: registryMatch?.color,
          decimals: registryMatch?.decimals ?? 18,
          chainId: chains?.[0],
          chains,
        };
      });
  } catch (err) {
    console.warn('CoinGecko markets fetch error:', err);
    return [];
  }
}

/**
 * Gets the USD price for any token symbol from CoinGecko.
 * Tries multiple lookup strategies: direct symbol, normalized (WETH→ETH), CoinGecko ID.
 * Falls back to simulated price if not found.
 */
async function getUsdPriceFromApi(symbol: string): Promise<number> {
  const prices = await getCachedPrices();

  // Direct symbol lookup
  if (prices[symbol] && prices[symbol] > 0) {
    return prices[symbol];
  }

  // Try without W prefix (WETH → ETH)
  if (symbol.startsWith('W') || symbol.startsWith('w')) {
    const normalized = symbol.slice(1);
    if (prices[normalized] && prices[normalized] > 0) {
      return prices[normalized];
    }
  }

  // Try CoinGecko ID lookup
  const geckoId = COINGECKO_IDS[symbol];
  if (geckoId && prices[geckoId] && prices[geckoId] > 0) {
    return prices[geckoId];
  }

  // Stablecoins
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
    return 1;
  }

  return 0; // Unknown token, will fall back to simulated
}

// Simulated fallback prices (used when API is unavailable or token unknown)
const SIMULATED_PRICES: Record<string, number> = {
  WETH: 3450, ETH: 3450,
  WBTC: 68200, BTC: 68200,
  USDC: 1, USDT: 1, DAI: 1,
  LINK: 189, UNI: 7.5, LDO: 1.6, AAVE: 95,
  SOL: 145, PEPE: 0.00002, DOGE: 0.12,
  AVAX: 35, MATIC: 0.85, ARB: 1.2, OP: 2.5,
  INJ: 25, ATOM: 9, DOT: 7, APT: 8,
};

// ---------------------------------------------------------------------------
// Public API — what the UI layer calls.
// ---------------------------------------------------------------------------

/**
 * Fetches the price of `baseToken` in terms of `quoteToken`.
 *
 * Uses CoinGecko API as the PRIMARY source (works for ANY token).
 * Falls back to simulated prices if API unavailable.
 *
 * Returns the price as a number (e.g. 3450.0 means 1 WETH = 3450 USDC).
 */
export async function getTokenPrice(
  baseSymbol: string,
  quoteSymbol: string,
  chainId: number
): Promise<number> {
  // For stablecoin pairs, price is always 1.
  const stablecoins = ['USDC', 'USDT', 'DAI'];
  if (stablecoins.includes(baseSymbol) && stablecoins.includes(quoteSymbol)) {
    return 1;
  }

  // Use CoinGecko API for real market prices (works for ANY token).
  const baseUsd = await getUsdPriceFromApi(baseSymbol);
  const quoteUsd = await getUsdPriceFromApi(quoteSymbol);

  // If we got real prices from the API, use them.
  if (baseUsd > 0 && quoteUsd > 0) {
    return baseUsd / quoteUsd;
  }

  // Fallback to simulated prices.
  const baseSim = SIMULATED_PRICES[baseSymbol] ?? 1;
  const quoteSim = SIMULATED_PRICES[quoteSymbol] ?? 1;
  return baseSim / quoteSim;
}

/**
 * Fetches the USD price for any token from CoinGecko API.
 * Works for ANY token symbol without hardcoded addresses.
 * Falls back to simulated price if API unavailable or token unknown.
 */
export async function getUsdPrice(symbol: string, chainId: number): Promise<number> {
  // Stablecoins are always $1
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
    return 1;
  }

  // Try CoinGecko API for real market price.
  const price = await getUsdPriceFromApi(symbol);
  if (price > 0) {
    return price;
  }

  // Fallback to simulated price.
  return SIMULATED_PRICES[symbol] ?? 1;
}

// ---------------------------------------------------------------------------
// On-chain helpers (kept for potential swap execution path, not UI display).
// ---------------------------------------------------------------------------

/** Uniswap pool ABI (minimal — just what we need for slot0 / price). */
const POOL_ABI = [
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint8' },
      { name: 'liquidityRate', type: 'uint128' },
      { name: 'maxLiquidityRate', type: 'uint128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'fee',
    outputs: [{ name: 'fee', type: 'uint24' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** ERC20 ABI (balanceOf + decimals). */
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Normalizes a catalog address to viem's canonical checksummed form. The
 * catalog's mixed-case strings mirror the server/Rust mirrors verbatim and a
 * stale bundle can hold an outdated checksum — viem rejects anything that is
 * not exactly EIP-55 ("Address is invalid"), so every on-chain call goes
 * through here. Returns null when the string is not an address at all.
 */
function toChecksumAddress(value: string | undefined): Address | null {
  if (!value) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/** Creates a viem public client for the given chain ID using the configured RPC. */
// ---------------------------------------------------------------------------
// Circuit breaker — when a chain's public RPC starts failing (429/CORS/net),
// stop hammering it for COOLDOWN_MS. Every call in the window returns 0/null
// locally with a single debug log, so a dead endpoint costs O(1) noise instead
// of (requests × retries) errors per 12s tick. Reset automatically.
// ---------------------------------------------------------------------------
const COOLDOWN_MS = 60_000;
const chainFailures = new Map<number, { count: number; blockedUntil: number; lastReason: string }>();
const FAILURE_THRESHOLD = 2;

function rpcCircuitOpen(chainId: number): boolean {
  const state = chainFailures.get(chainId);
  return !!state && Date.now() < state.blockedUntil;
}

function recordRpcFailure(chainId: number, reason: string): void {
  const state = chainFailures.get(chainId) ?? { count: 0, blockedUntil: 0, lastReason: '' };
  state.count += 1;
  state.lastReason = reason;
  if (state.count >= FAILURE_THRESHOLD) {
    state.blockedUntil = Date.now() + COOLDOWN_MS;
    console.debug(`[rpc] chain ${chainId} paused for ${COOLDOWN_MS / 1000}s (${reason})`);
  }
  chainFailures.set(chainId, state);
}

function recordRpcSuccess(chainId: number): void {
  chainFailures.delete(chainId);
}

/** True when the failure is an RPC-side problem worth tripping the breaker
 * (network/CORS/rate-limit), not a contract-level revert (wrong chain etc.). */
function isTransportFailure(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /HttpRequestError|TimeoutError|Failed to fetch|CORS|429|rate limit/i.test(msg);
}

function createClientForChain(chainId: number) {
  const chain = CHAIN_BY_ID[chainId];
  if (!chain) return null;

  // retryCount:0 — the live-data loop already retries on its next tick; viem's
  // default 3× retry on a rate-limited endpoint multiplies one failure into
  // four requests and feeds the 429 storm. batch size kept at 1: with batch
  // multicall the whole request fails when the RPC throttles it.
  return createPublicClient({
    chain,
    transport: http(getRpcUrlForChain(chainId), { retryCount: 0, batch: { wait: 0 } }),
  });
}

// Cache the current client so we don't recreate it on every read.
let currentClient: ReturnType<typeof createClientForChain> | null = null;
let currentChainId: number | null = null;

/** Returns (or creates) a public client for the active chain. */
export function getPublicClient(chainId: number) {
  if (currentClient && currentChainId === chainId) {
    return currentClient;
  }
  currentClient = createClientForChain(chainId);
  currentChainId = chainId;
  return currentClient;
}

/**
 * Reads the current sqrtPriceX96 from a Uniswap v3 pool and converts it to
 * a token price ratio. Used for on-chain swap execution path only.
 */
export async function getPoolPrice(
  poolAddress: Address,
  chainId: number
): Promise<{ sqrtPriceX96: bigint; tick: number; price0In1: number; price1In0: number } | null> {
  const client = getPublicClient(chainId);
  if (!client || rpcCircuitOpen(chainId)) return null;

  try {
    const slot0Result = await client.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    });
    recordRpcSuccess(chainId);

    const sqrtPriceX96 = (slot0Result as unknown as readonly unknown[])[0] as bigint;
    const tick = (slot0Result as unknown as readonly unknown[])[4] as number;

    const sqrtPriceX96Squared = sqrtPriceX96 * sqrtPriceX96;
    const twoTo192 = BigInt(2) ** BigInt(192);
    const price0In1 = Number(sqrtPriceX96Squared) / Number(twoTo192);
    const price1In0 = price0In1 > 0 ? 1 / price0In1 : 0;

    return { sqrtPriceX96, tick, price0In1, price1In0 };
  } catch (err) {
    console.warn('Failed to read Uniswap pool price:', err);
    return null;
  }
}

/**
 * Reads the ERC20 balance of an address for a given token.
 * Returns the balance in human-readable units.
 */
export async function getTokenBalance(
  tokenSymbol: string,
  owner: Address | string,
  chainId: number
): Promise<number> {
  const token = TOKENS[tokenSymbol];
  if (!token) return 0;
  if (rpcCircuitOpen(chainId)) return 0;

  // Per-chain address override — keep in sync with the server's
  // TOKEN_ADDRESS_BY_CHAIN[1301] in apps/server/src/uniswapApi.ts: WETH is
  // the OP-Stack canonical contract and USDC is the official Unichain
  // Sepolia testnet faucet token (chain 1301, the public real-asset pool).
  const CHAIN_TOKEN_OVERRIDES: Record<number, Record<string, Address>> = {
    1301: {
      WETH: '0x4200000000000000000000000000000000000006' as Address,
      USDC: '0x31d0220469e10c4E71834a79b1f276d740d3768F' as Address,
    },
  };
  const overrideAddress = CHAIN_TOKEN_OVERRIDES[chainId]?.[tokenSymbol];
  const resolvedAddress = (overrideAddress ?? token.address) as Address;

  const tokenAddress = toChecksumAddress(resolvedAddress);
  const ownerAddress = toChecksumAddress(owner);
  // Invalid address or no client → fail SOFT with a quiet debug log (the
  // balance read is decorative UI data; never spam the console or throw).
  if (!tokenAddress || !ownerAddress) {
    console.debug(`[balance] ${tokenSymbol}: skipped (invalid token/owner address)`);
    return 0;
  }

  const client = getPublicClient(chainId);
  if (!client) return 0;

  try {
    const balanceRaw = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });

    const decimalsRaw = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });

    const decimals = Number(decimalsRaw);
    recordRpcSuccess(chainId);
    return parseFloat(formatUnits(balanceRaw as bigint, decimals));
  } catch (err) {
    // Graceful degradation: rate-limit (429), CORS-blocked transport,
    // timeouts — a failed balance read is a UI non-event. Debug-level log,
    // balance 0, exception never escapes to React. Transport failures also
    // trip the per-chain circuit breaker (see COOLDOWN_MS above).
    if (isTransportFailure(err)) recordRpcFailure(chainId, err instanceof Error ? err.name : 'error');
    console.debug(`[balance] ${tokenSymbol}: unavailable (${err instanceof Error ? err.name : 'error'})`);
    return 0;
  }
}

/**
 * Reads the native ETH balance of an address.
 * Returns the balance in ETH.
 */
export async function getNativeBalance(
  owner: Address | string,
  chainId: number
): Promise<number> {
  const client = getPublicClient(chainId);
  if (!client || rpcCircuitOpen(chainId)) return 0;

  try {
    const balanceRaw = await client.getBalance({ address: owner as Address });
    recordRpcSuccess(chainId);
    return parseFloat(formatUnits(balanceRaw as bigint, 18));
  } catch (err) {
    // Same soft-fail contract as getTokenBalance (rate limit, CORS, timeout).
    if (isTransportFailure(err)) recordRpcFailure(chainId, err instanceof Error ? err.name : 'error');
    console.debug(`[balance] native: unavailable (${err instanceof Error ? err.name : 'error'})`);
    return 0;
  }
}

/**
 * Reads the latest block number from the chain.
 */
export async function getBlockNumber(chainId: number): Promise<number> {
  const client = getPublicClient(chainId);
  if (!client || rpcCircuitOpen(chainId)) return 0;

  try {
    const bn = await client.getBlockNumber();
    recordRpcSuccess(chainId);
    return Number(bn);
  } catch (err) {
    if (isTransportFailure(err)) recordRpcFailure(chainId, err instanceof Error ? err.name : 'error');
    console.debug(`[rpc] block number unavailable: ${err instanceof Error ? err.name : 'error'}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Returns the human-readable chain name for a chain ID. */
export function getChainName(chainId: number): string {
  const names: Record<number, string> = {
    [sepolia.id]: 'Sepolia',
    [mainnet.id]: 'Ethereum',
    [arbitrum.id]: 'Arbitrum',
    [base.id]: 'Base',
    [polygon.id]: 'Polygon',
  };
  return names[chainId] ?? 'Unknown';
}

/** Whether the given chain is a testnet (Sepolia). */
export function isTestnet(chainId: number): boolean {
  return chainId === sepolia.id;
}
