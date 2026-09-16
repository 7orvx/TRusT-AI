// Phase 4 — live on-chain price feed (first slice).
//
// Reads the real Uniswap v4 pool price (slot0.sqrtPriceX96) for the monitored
// pair through the user's validated RPC endpoint (the dashboard RPC plug-in or
// .env), with a transparent fallback chain:
//   1. v4 pool slot0 (source: "pool")       — the real pool price
//   2. CoinGecko base/quote ratio (source: "coingecko") — real market price
//      when the pair has no usable v4 pool (e.g. WETH/USDC on Sepolia)
//   3. Synthetic engine price (source: "synthetic") — last resort, unchanged
//
// The playground (mUSDC/mUSDT on Unichain Sepolia) keeps working: its pool
// data mirrors the routeConfig PoolKey defaults (fee 2500 / tick 25), so the
// reader targets the same user-deployed pool the swaps already hit.

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { rpcConfig } from './index.js';

// v4 PoolManager per network — mirrors V4_POOL_MANAGER_BY_NETWORK in
// uniswapApi.ts (keep in sync).
const V4_POOL_MANAGER_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0x00b036b58a818b1bc34d502d3fe730db729e62ac',
  unichain: '0x1f98400000000000000000000000000000000004',
  ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
};

// Expected chain id per network key — guards the RPC candidate against a
// wrong/mismatched link (same policy as the quoter in uniswapApi.ts).
const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  'unichain-sepolia': 1301,
  unichain: 130,
  ethereum: 1,
};

// Well-known public RPC fallbacks when the dashboard link is unset/mismatched
// (same list as rpcCandidates in uniswapApi.ts — keep in sync).
const PUBLIC_RPC_BY_NETWORK: Record<string, string> = {
  'unichain-sepolia': 'https://sepolia.unichain.org',
  unichain: 'https://unichain.org',
  ethereum: 'https://eth.llamarpc.com',
};

// Per-token decimals + mainnet addresses (mirrors TOKEN_DECIMALS in
// uniswapApi.ts and TOKEN_CATALOG in the engine — keep in sync).
const TOKENS: Record<string, { address: string; decimals: number }> = {
  WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
  WBTC: { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', decimals: 8 },
  USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  LINK: { address: '0x514910771af9ca656af840dff83e8264ecf986ca', decimals: 18 },
  UNI: { address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', decimals: 18 },
  DAI: { address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18 },
  LDO: { address: '0x5a98fcbea516cf06857215779fd812ca3bef1b32', decimals: 18 },
  AAVE: { address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', decimals: 18 },
  mUSDT: { address: '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06', decimals: 6 },
  mUSDC: { address: '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860', decimals: 6 },
};

// PoolKey params per known playground pair (the engine + routeConfig defaults;
// the user's deployed mUSDC/mUSDT v4 pool on Unichain Sepolia). A pair not
// listed here has no known v4 pool → the reader falls back before even trying.
const POOL_KEYS: Record<string, { fee: number; tickSpacing: number } | undefined> = {
  'mUSDC/mUSDT': { fee: 2500, tickSpacing: 25 },
  'mUSDT/mUSDC': { fee: 2500, tickSpacing: 25 },
};

export type PriceSource = 'pool' | 'coingecko' | 'synthetic';

export interface LivePrice {
  price: number;
  source: PriceSource;
}

// CoinGecko ids for the quote/base ratio fallback (market pairs only).
const COINGECKO_IDS: Record<string, string> = {
  WETH: 'ethereum',
  WBTC: 'bitcoin',
  LINK: 'chainlink',
  UNI: 'uniswap',
  DAI: 'dai',
  LDO: 'lido-dao',
  AAVE: 'aave',
  USDC: 'usd-coin',
  USDT: 'tether',
};

let coingeckoCache: { at: number; prices: Record<string, number> } | null = null;
const COINGECKO_TTL_MS = 60_000;

async function coingeckoPrices(): Promise<Record<string, number>> {
  if (coingeckoCache && Date.now() - coingeckoCache.at < COINGECKO_TTL_MS) {
    return coingeckoCache.prices;
  }
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return coingeckoCache?.prices ?? {};
    const data = await res.json() as Record<string, { usd?: number }>;
    const prices: Record<string, number> = {};
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
      const usd = data[id]?.usd;
      if (typeof usd === 'number' && usd > 0) prices[sym] = usd;
    }
    coingeckoCache = { at: Date.now(), prices };
    return prices;
  } catch {
    return coingeckoCache?.prices ?? {};
  }
}

// RPC candidates for pool reads, in priority order: the dashboard-configured
// link (only when it targets the same network) then a well-known public RPC.
function rpcCandidates(net: string): string[] {
  const list: string[] = [];
  if (rpcConfig && rpcConfig.configured && rpcConfig.url && (rpcConfig.network || '').toLowerCase() === net) {
    list.push(rpcConfig.url);
  }
  const fallback = PUBLIC_RPC_BY_NETWORK[net];
  if (fallback) list.push(fallback);
  return list;
}

interface Slot0Result { sqrtPriceX96: bigint }

// Reads slot0 for the pair's v4 pool via the PoolManager. Returns null when
// there is no known pool for the pair, no RPC candidate, or every candidate
// fails/answers on the wrong chain. Never throws.
async function readPoolSlot0(pairId: string, net: string): Promise<Slot0Result | null> {
  const poolManager = V4_POOL_MANAGER_BY_NETWORK[net];
  const expectedChainId = CHAIN_ID_BY_NETWORK[net];
  const poolKey = POOL_KEYS[pairId];
  if (!poolManager || expectedChainId === undefined || !poolKey) return null;

  const base = TOKENS[pairId.split('/')[0]];
  const quote = TOKENS[pairId.split('/')[1]];
  if (!base || !quote) return null;

  // v4 PoolKey: currencies sorted numerically (hex-string order works for
  // equal-length addresses), fee, tickSpacing, hooks (none on the playground).
  const [currency0, currency1] = [base.address.toLowerCase(), quote.address.toLowerCase()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) as [`0x${string}`, `0x${string}`];

  const SLOT0_ABI = [{
    name: 'getSlot0',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' }
    ]
  }] as const;

  // poolId = keccak256(abi.encode(PoolKey)) — same derivation as
  // uniswapApi.ts (hooks = zero address).
  const { keccak256, encodeAbiParameters } = await import('viem');
  const poolId = keccak256(encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' },
      { type: 'uint24' }, { type: 'int24' }, { type: 'address' }
    ],
    [currency0, currency1, poolKey.fee, poolKey.tickSpacing, '0x0000000000000000000000000000000000000000' as `0x${string}`]
  ));

  const callData = encodeFunctionData({ abi: SLOT0_ABI, functionName: 'getSlot0', args: [poolId] });

  for (const rpcUrl of rpcCandidates(net)) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 6000 }) });
      const chainId = await client.getChainId();
      if (chainId !== expectedChainId) continue; // wrong-chain link, next candidate
      const res = await client.call({ to: poolManager, data: callData });
      if (!res.data || res.data === '0x') continue;
      const decoded = decodeFunctionResult({
        abi: SLOT0_ABI,
        functionName: 'getSlot0',
        data: res.data
      }) as unknown as Slot0Result & Record<string, unknown>;
      if (decoded.sqrtPriceX96 > 0n) return { sqrtPriceX96: decoded.sqrtPriceX96 };
    } catch {
      // candidate failed — try the next one
    }
  }
  return null;
}

// Converts slot0.sqrtPriceX96 into a human price of token1 per token0:
//   price_t1_per_t0 = (sqrtPriceX96 / 2^96)^2
// The pair price is quote-per-base, so depending on the sort order we take the
// value or its reciprocal.
function priceFromSlot0(sqrtPriceX96: bigint, base: { address: string }, quote: { address: string }): number {
  const q = Number(sqrtPriceX96) / Number(1n << 96n);
  const priceToken1PerToken0 = q * q;
  const baseIsToken0 = base.address.toLowerCase() < quote.address.toLowerCase();
  return baseIsToken0 ? priceToken1PerToken0 : 1 / priceToken1PerToken0;
}

// In-memory short cache so the trigger loop (every ~2.5 s) doesn't hammer the
// RPC. Pool prices move block by block; 4 s keeps them fresh enough while
// staying far below any provider rate limit.
const slot0Cache = new Map<string, { at: number; value: Slot0Result | null }>();
const SLOT0_TTL_MS = 4_000;

/**
 * Resolves the live price for the monitored pair. Never throws — on any
 * failure the synthetic price passes through untouched (source: "synthetic").
 */
export async function getLivePairPrice(
  pairId: string,
  net: string,
  syntheticPrice: number
): Promise<LivePrice> {
  try {
    // 1. Real v4 pool price (playground pool first-class).
    const cached = slot0Cache.get(`${net}:${pairId}`);
    let slot0: Slot0Result | null;
    if (cached && Date.now() - cached.at < SLOT0_TTL_MS) {
      slot0 = cached.value;
    } else {
      slot0 = await readPoolSlot0(pairId, net);
      slot0Cache.set(`${net}:${pairId}`, { at: Date.now(), value: slot0 });
    }
    const base = TOKENS[pairId.split('/')[0]];
    const quote = TOKENS[pairId.split('/')[1]];
    if (slot0 && base && quote) {
      const price = priceFromSlot0(slot0.sqrtPriceX96, base, quote);
      if (Number.isFinite(price) && price > 0) return { price, source: 'pool' };
    }

    // 2. CoinGecko base/quote ratio (real market pairs without a v4 pool).
    const prices = await coingeckoPrices();
    const baseUsd = prices[pairId.split('/')[0]];
    const quoteUsd = prices[pairId.split('/')[1]];
    if (baseUsd > 0 && quoteUsd > 0) {
      return { price: baseUsd / quoteUsd, source: 'coingecko' };
    }
  } catch {
    // fall through to synthetic
  }
  return { price: syntheticPrice, source: 'synthetic' };
}
