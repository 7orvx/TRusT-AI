// Pair → network resolution for the unified pair+network picker.
//
// The header network dropdown was removed: the EXECUTION network is now
// derived from the monitored pair (whichever network tab the pair was picked
// under). This module is the single web-side source of truth for that mapping.
//
// Presentation/routing metadata only — it never mutates the token symbols or
// addresses shared with the Rust engine (crates/engine stays frozen).
//
// SYNC NOTE: CHAIN_TOKEN_COVERAGE mirrors the server's TOKEN_ADDRESS_BY_CHAIN
// (apps/server/src/uniswapApi.ts). When a token is added to that server map,
// add it here too so the pair builder only offers executable combinations.
// Chain 1301 coverage is the Unichain Sepolia mock playground (mUSDC/mUSDT).

export interface PickerNetwork {
  chainId: number;
  /** Server network key — must mirror resolveNetwork() in apps/server/src/uniswapApi.ts. */
  networkKey: string;
  label: string;
}

// Tabs of the unified pair picker, in display order.
export const PICKER_NETWORKS: PickerNetwork[] = [
  { chainId: 1, networkKey: 'ethereum', label: 'Ethereum' },
  { chainId: 42161, networkKey: 'arbitrum', label: 'Arbitrum' },
  { chainId: 8453, networkKey: 'base', label: 'Base' },
  { chainId: 137, networkKey: 'polygon', label: 'Polygon' },
  { chainId: 130, networkKey: 'unichain', label: 'Unichain' },
  { chainId: 1301, networkKey: 'unichain-sepolia', label: 'Unichain Sepolia' },
];

const NETWORK_KEY_BY_CHAIN_ID = new Map(PICKER_NETWORKS.map((n) => [n.chainId, n.networkKey]));
const CHAIN_ID_BY_NETWORK_KEY = new Map(PICKER_NETWORKS.map((n) => [n.networkKey, n.chainId]));

export function networkKeyForChainId(chainId: number): string | undefined {
  return NETWORK_KEY_BY_CHAIN_ID.get(chainId);
}

export function chainIdForNetworkKey(key: string): number | undefined {
  return CHAIN_ID_BY_NETWORK_KEY.get(key.toLowerCase());
}

export function pickerNetworkLabel(chainId: number): string {
  return PICKER_NETWORKS.find((n) => n.chainId === chainId)?.label ?? `chain ${chainId}`;
}

// Per-chain tradable symbols — mirror of the server's TOKEN_ADDRESS_BY_CHAIN.
// CURATED CATALOG: ~10 executable tokens per network (top-liquidity main pairs
// with verified contracts). The picker's BASE side offers exactly these per
// tab; the QUOTE side offers the same set (every combination here is a real,
// swap-capable pool pair). Expanding to 20/30/40 per network = add to the
// server map + mirror here.
const CHAIN_TOKEN_COVERAGE: Record<number, Set<string>> = {
  1: new Set(['WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'UNI', 'DAI', 'LDO', 'AAVE']), // 9
  42161: new Set(['WETH', 'WBTC', 'USDC', 'LINK', 'UNI', 'DAI', 'LDO', 'AAVE']), // 8
  8453: new Set(['WETH', 'USDC', 'UNI', 'DAI', 'AAVE']), // 5
  137: new Set(['WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'UNI', 'DAI', 'AAVE']), // 8
  130: new Set(['WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'UNI', 'DAI', 'LDO', 'AAVE']), // 9 — verified via Uniswap Token List (2026-09-16)
  1301: new Set(['mUSDC', 'mUSDT']), // mock playground pool
};

/** Cap for dynamic (price-only, non-registry) tokens shown per network tab —
 * the counterpart list stays SHORT and curated, never the top-100 firehose. */
export const MAX_DYNAMIC_TOKENS_PER_TAB = 10;

/**
 * True when BOTH sides of the pair have a verified contract on the chain
 * (base must be in the coverage set; quote must exist there as well). Mock
 * pairs are only valid on Unichain Sepolia.
 */
export function pairSupportedOnChain(base: string, quote: string, chainId: number): boolean {
  const coverage = CHAIN_TOKEN_COVERAGE[chainId];
  if (!coverage) return false;
  return coverage.has(base) && coverage.has(quote);
}

/** Chains (from PICKER_NETWORKS) where the pair can execute — picker hinting. */
export function supportedChainsForPair(base: string, quote: string): number[] {
  return PICKER_NETWORKS.filter((n) => pairSupportedOnChain(base, quote, n.chainId)).map((n) => n.chainId);
}

export const MOCK_PAIR_CHAIN_ID = 1301;
export const isMockSymbol = (symbol: string): boolean => symbol === 'mUSDC' || isMockSymbolName(symbol);
function isMockSymbolName(symbol: string): boolean {
  return symbol === 'mUSDT';
}
export const isMockPair = (base: string, quote: string): boolean => isMockSymbol(base) || isMockSymbol(quote);

/**
 * Default execution network key for a pair — mirrors the SERVER's
 * resolveNetwork() fallback chain (apps/server/src/uniswapApi.ts) so the web
 * preview and the actual route never diverge:
 *   mock pair → unichain-sepolia; ETH base → ethereum; BTC base → ethereum;
 *   otherwise the highest-id chain where BOTH sides are tradable (Polygon →
 *   Base → Arbitrum → Ethereum is the L2-first preference), falling back to
 *   ethereum when the coverage map has no exact match.
 */
export function pickNetworkForPair(base: string, quote: string): string | undefined {
  if (isMockPair(base, quote)) return 'unichain-sepolia';
  if (base === 'ETH' || base === 'BTC' || base === 'WETH' || base === 'WBTC') return 'ethereum';
  const candidates = [137, 8453, 42161, 1]; // L2-first preference
  for (const chainId of candidates) {
    if (pairSupportedOnChain(base, quote, chainId)) return networkKeyForChainId(chainId);
  }
  return 'ethereum';
}

/** localStorage key for the monitored pair's execution chain. */
export const PAIR_CHAIN_STORAGE_KEY = 'trust_ai_pair_chain';
/** localStorage key persisting the user's monitored pair across reloads. */
export const PAIR_STORAGE_KEY = 'trust_ai_selected_pair';
/** localStorage key holding this dashboard instance's id (echo guards). */
export const PAIR_INSTANCE_KEY = 'trust_ai_client_instance';
