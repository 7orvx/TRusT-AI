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
// uniswapApi.ts (keep in sync; L2 addresses from the official deployments
// table at docs.uniswap.org/contracts/v4/deployments).
const V4_POOL_MANAGER_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0x00b036b58a818b1bc34d502d3fe730db729e62ac',
  sepolia: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  unichain: '0x1f98400000000000000000000000000000000004',
  ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  arbitrum: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  polygon: '0x67366782805870060151383f4bbff9dab53e5cd6',
};

// v4 StateView lens per network (official deployments table — keep in sync).
// PRIMARY slot0 reader: on several chains (e.g. Unichain Sepolia) the
// PoolManager itself REVERTS on direct getSlot0(bytes32) calls — the StateView
// lens is the supported read path. Falls back to a direct PoolManager call
// where no lens address is cataloged.
const V4_STATE_VIEW_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0xc199f1072a74d4e905aba1a84d9a45e2546b6222',
  // Ethereum Sepolia — official v4 deployment (deployments feed).
  sepolia: '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C',
  unichain: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2',
  ethereum: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  arbitrum: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  base: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  polygon: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
};

// Expected chain id per network key — guards the RPC candidate against a
// wrong/mismatched link (same policy as the quoter in uniswapApi.ts).
const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  'unichain-sepolia': 1301,
  unichain: 130,
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  sepolia: 11155111,
};

// Well-known public RPC fallbacks when the dashboard link is unset/mismatched
// (same list as rpcCandidates in uniswapApi.ts — keep in sync).
const PUBLIC_RPC_BY_NETWORK: Record<string, string> = {
  'unichain-sepolia': 'https://sepolia.unichain.org',
  unichain: 'https://unichain.org',
  ethereum: 'https://eth.llamarpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base: 'https://mainnet.base.org',
  polygon: 'https://polygon-rpc.com',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
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
// NOTE: WETH/USDC entries above keep their MAINNET addresses (CoinGecko ratio
// fallback uses symbols only). On testnet chains, TESTNET_ADDRESS_BY_NETWORK
// below resolves the real per-chain contracts for the pool read.

// Per-network override for tokens whose TESTNET contract differs from the
// mainnet address above (the engine catalog is mainnet-addressed). Unichain
// Sepolia: WETH = OP-Stack canonical WETH9, USDC = official testnet USDC.
const TESTNET_ADDRESS_BY_NETWORK: Record<string, Record<string, string>> = {
  'unichain-sepolia': {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  },
  // Ethereum Sepolia: the executable public pair is the NATIVE-ETH pool —
  // the WETH base resolves to the native sentinel so the PoolKey matches
  // the on-chain pool (currency0 = zero address). USDC = Circle's official
  // Sepolia testnet token.
  sepolia: {
    WETH: '0x0000000000000000000000000000000000000000',
    USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  },
};

// PoolKey params per known playground pair (the engine + routeConfig defaults;
// the user's deployed mUSDC/mUSDT v4 pool on Unichain Sepolia). A pair not
// listed here has no known v4 pool → the reader falls back before even trying.
// 'WETH/USDC' on Unichain Sepolia is the PUBLIC real-asset pool (hookless
// fee 500 / tick 10, poolId 0x71fba4ef…41422, liquidity > 0, live-quoted via
// V4Quoter on 2026-09-17) — anyone can test a real swap against it.
const POOL_KEYS: Record<string, { fee: number; tickSpacing: number } | undefined> = {
  'mUSDC/mUSDT': { fee: 2500, tickSpacing: 25 },
  'mUSDT/mUSDC': { fee: 2500, tickSpacing: 25 },
  'WETH/USDC': { fee: 500, tickSpacing: 10 },
};
// The 'WETH/USDC' PoolKey differs per network (Unichain Sepolia = the public
// WETH/USDC pool; Ethereum Sepolia = the public NATIVE-ETH/USDC pool). The
// table above keeps the Unichain default; the getter overrides per network.
function poolKeyFor(net: string, pairId: string): { fee: number; tickSpacing: number } | undefined {
  if (net === 'sepolia' && pairId.toUpperCase() === 'WETH/USDC') {
    return { fee: 10000, tickSpacing: 200 }; // public nativeETH/USDC tier
  }
  return POOL_KEYS[pairId];
}

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
  const poolKey = poolKeyFor(net, pairId);
  if (!poolManager || expectedChainId === undefined || !poolKey) return null;

  const baseEntry = TOKENS[pairId.split('/')[0]];
  const quoteEntry = TOKENS[pairId.split('/')[1]];
  if (!baseEntry || !quoteEntry) return null;

  // Testnet chains resolve the REAL per-chain contracts (the catalog entries
  // above are mainnet-addressed).
  const netOverride = TESTNET_ADDRESS_BY_NETWORK[net];
  const resolve = (sym: string, entry: { address: string }) =>
    netOverride?.[sym]?.toLowerCase() ?? entry.address.toLowerCase();
  const base = { ...baseEntry, address: resolve(pairId.split('/')[0], baseEntry) };
  const quote = { ...quoteEntry, address: resolve(pairId.split('/')[1], quoteEntry) };

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
      // Primary: StateView lens; fallback: direct PoolManager call (older
      // chains where the lens may be missing).
      const stateView = V4_STATE_VIEW_BY_NETWORK[net];
      const targets: `0x${string}`[] = stateView ? [stateView, poolManager] : [poolManager];
      for (const target of targets) {
        try {
          const res = await client.call({ to: target, data: callData });
          if (!res.data || res.data === '0x') continue;
          // viem decodes multi-output tuples POSITIONALLY (an array) even with
          // named outputs — access by index, not by property name (a named
          // read on the array is undefined and silently falsified the >0
          // check, degrading every pool read to the CoinGecko fallback).
          const decoded = decodeFunctionResult({
            abi: SLOT0_ABI,
            functionName: 'getSlot0',
            data: res.data
          }) as unknown;
          const sqrtRaw = Array.isArray(decoded)
            ? (decoded[0] as bigint | undefined)
            : (decoded as Slot0Result)?.sqrtPriceX96;
          if (typeof sqrtRaw === 'bigint' && sqrtRaw > 0n) {
            return { sqrtPriceX96: sqrtRaw };
          }
        } catch {
          // Expected on chains where the direct PoolManager call reverts
          // (e.g. Unichain Sepolia) — the StateView attempt above is the
          // supported path; silent fallthrough keeps per-trigger logs clean.
        }
      }
    } catch (e) {
      console.warn(`🔍 [Slot0] rpc ${rpcUrl} failed: ${(e as Error).message?.slice(0, 100)}`);
    }
  }
  return null;
}

// Converts slot0.sqrtPriceX96 into a human price of token1 per token0:
//   price_t1_per_t0 = (sqrtPriceX96 / 2^96)^2
// The pair price is quote-per-base, so depending on the sort order we take the
// value or its reciprocal. Slot0's raw ratio is in RAW token units — the
// decimal difference (e.g. WETH 18 vs USDC 6) must be normalized or every
// price is off by 10^(dec0 − dec1).
function priceFromSlot0(
  sqrtPriceX96: bigint,
  base: { address: string; decimals: number },
  quote: { address: string; decimals: number }
): number {
  const q = Number(sqrtPriceX96) / Number(1n << 96n);
  const priceToken1PerToken0Raw = q * q;
  const baseIsToken0 = base.address.toLowerCase() < quote.address.toLowerCase();
  // Raw → human adjustment is 10^(dec_base − dec_quote) in BOTH branches:
  // e.g. WETH(18)/USDC(6) with USDC as currency0 → reciprocal branch, and the
  // human "USDC per WETH" = raw-ratio × 10^(18−6) = ×1e12.
  const decimalAdj = 10 ** (base.decimals - quote.decimals);
  return baseIsToken0
    ? priceToken1PerToken0Raw * decimalAdj
    : (1 / priceToken1PerToken0Raw) * decimalAdj;
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
    const baseEntry = TOKENS[pairId.split('/')[0]];
    const quoteEntry = TOKENS[pairId.split('/')[1]];
    if (slot0 && baseEntry && quoteEntry) {
      // Apply the SAME per-chain address resolution as readPoolSlot0 — on
      // testnets the base/quote addresses that built the PoolKey (e.g. the
      // native sentinel for the Sepolia native-ETH pool) differ from the
      // mainnet catalog rows, and the sort-order branch would invert.
      const netOverride = TESTNET_ADDRESS_BY_NETWORK[net];
      const base = {
        ...baseEntry,
        address: netOverride?.[pairId.split('/')[0]]?.toLowerCase() ?? baseEntry.address.toLowerCase(),
      };
      const quote = {
        ...quoteEntry,
        address: netOverride?.[pairId.split('/')[1]]?.toLowerCase() ?? quoteEntry.address.toLowerCase(),
      };
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
