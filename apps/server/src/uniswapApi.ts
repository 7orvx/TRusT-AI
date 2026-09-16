import { encodeFunctionData, encodeAbiParameters, keccak256, parseUnits, createPublicClient, http, decodeFunctionResult } from 'viem';
import { MarketTrigger } from './aiProvider.js';
import { rpcConfig, routeConfig } from './index.js';

export interface UniswapSwapData {
  to_address: string;
  calldata: string;
  value_wei: string;
  route_summary: string;
  estimated_gas_units: number;
  router_name: string;
  // Chain id the calldata actually targets (derived from the resolved route
  // network, never from the wallet or RPC label). The dashboard compares it
  // numerically against wagmi's chainId — no more text-sniffing the route
  // summary string, which produced false chain-mismatch blocks when the RPC
  // plug-in network label diverged from the wallet.
  wallet_chain_id?: number;
  // Route metadata. The legacy v3 route was removed (v4-only product
  // direction, 2026-09-15): every decision carries Uniswap v4 Universal
  // Router calldata executed via Permit2 approvals — no recipient patch, the
  // UR's TAKE_ALL sends the output to msg.sender. token_in_address /
  // amount_in_wei echo the encoded input leg so the client's allowance gate
  // does not need to decode the calldata.
  protocol: 'v4';
  token_in_address: string;
  amount_in_wei: string;
  permit2_address?: string;
  v4_pool_manager_address?: string;
  v4_pool_id?: string;
  hook_address?: string;
  hook_permissions?: string;
}

// Universal Router execute ABI. v4 swaps are routed through the Universal
// Router's command dispatcher (`execute(commands, inputs, deadline)`) — see
// docs/reference/Uniswap-swap.md (Smart Contracts → Path A) and
// docs/design/uniswap-routing-v3-v4-hooks.md.
const UNIVERSAL_ROUTER_EXECUTE_ABI = [
  {
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' }
    ],
    name: 'execute',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

// Universal Router command byte for a v4 swap. Verified from
// uniswap/universal-router `contracts/libraries/Commands.sol` (V4_SWAP = 0x10
// on both the 2.0.0 tag and main).
const UR_COMMAND_V4_SWAP = '0x10';

// v4-periphery Actions byte values used by the UR's V4Router module (verified
// from uniswap/v4-periphery `src/libraries/Actions.sol`, unchanged between the
// UR-2.0-era Jan 2025 commit and main):
//   SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f
const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const V4_ACTION_SETTLE_ALL = 0x0c;
const V4_ACTION_TAKE_ALL = 0x0f;

// Permit2 is deployed at the same address on every chain that has it.
// The v4 Universal Router pulls ERC20 inputs via Permit2.transferFrom, so the
// dashboard must approve (token → Permit2) and (Permit2 → router) before the
// swap.
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Uniswap v4 Universal Router per network (the official v4 swap entry point —
// the standalone v4-periphery "Router" is NOT deployed on Unichain Sepolia):
//   - unichain-sepolia: 0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d
//     (v4 Universal Router on Unichain Sepolia — v4 deployments table)
//   - unichain:         0xef740bf23acae26f6492b10de645d6b98dc8eaf3
//     (v4 Universal Router on Unichain mainnet — same table)
//   - ethereum:         0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca
//     (Universal Router 2.1.1 on Ethereum mainnet — same table)
// An explicit UNISWAP_V4_ROUTER env var always wins. Networks missing from this
// map reject v4 routes with a clear error instead of silently sending calldata
// to the wrong contract.
const V4_ROUTER_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d',
  unichain: '0xef740bf23acae26f6492b10de645d6b98dc8eaf3',
  ethereum: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca',
};

// v4 Quoter per network (V4Quoter lens). The synthetic simulator price (1.0 for
// mUSDC/mUSDT) drifts from the real pool price (tick -31 ≈ 0.9969), so a
// slippage band computed from the synthetic price reverts on-chain with
// V4TooLittleReceived. The v4 route therefore anchors amountOutMinimum to a
// live quoteExactInputSingle call before encoding (see quoteV4Output).
const V4_QUOTER_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472',
  unichain: '0x333e3c607b141b18ff6de9f258db6e77fe7491e0',
  ethereum: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
};

// Expected chain id per network key — guards the quoter RPC candidate against a
// wrong/mismatched link (e.g. an .env RPC pointing at another chain).
const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  'unichain-sepolia': 1301,
  unichain: 130,
  ethereum: 1,
  // Sepolia only hosts the legacy v3 router (removed); v4 swaps target
  // Ethereum mainnet, Unichain and Unichain Sepolia. Kept here so the chain
  // guard can answer precisely instead of falling through.
  sepolia: 11155111,
};

// RPC candidates for the quoter call, in priority order: the dashboard-configured
// link (only when it targets the same network) then a well-known public RPC.
function rpcCandidates(net: string): string[] {
  const list: string[] = [];
  if (rpcConfig && rpcConfig.configured && rpcConfig.url && (rpcConfig.network || '').toLowerCase() === net) {
    list.push(rpcConfig.url);
  }
  const publicRpc: Record<string, string> = {
    'unichain-sepolia': 'https://sepolia.unichain.org',
    unichain: 'https://unichain.org',
    ethereum: 'https://eth.llamarpc.com'
  };
  const fallback = publicRpc[net];
  if (fallback) list.push(fallback);
  return list;
}

// Live quote for a v4 single-pool exact-input swap via the deployed V4Quoter.
// Returns the expected amountOut in tokenOut wei, or null when no quoter/RPC is
// available (the caller then falls back to the synthetic min-out). The quoter is
// a stateless lens — no allowances are needed for the eth_call simulation.
async function quoteV4Output(
  net: string,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountInWei: bigint,
  fee: number,
  tickSpacing: number,
  hooks: `0x${string}`
): Promise<bigint | null> {
  const quoter = V4_QUOTER_BY_NETWORK[net];
  const expectedChainId = CHAIN_ID_BY_NETWORK[net];
  if (!quoter || expectedChainId === undefined) return null;
  // The deployed-era quoter interface takes uint128 amounts.
  if (amountInWei >= (1n << 128n)) return null;
  const [currency0, currency1] = [tokenIn, tokenOut].sort((a, b) => (a < b ? -1 : 1));
  for (const rpcUrl of rpcCandidates(net)) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8000 }) });
      const chainId = await client.getChainId();
      if (chainId !== expectedChainId) continue; // wrong-chain link, try next candidate
      const data = encodeFunctionData({
        abi: [{
          name: 'quoteExactInputSingle',
          type: 'function',
          stateMutability: 'nonpayable',
          // The deployed V4Quoter takes ONE struct param —
          // QuoteExactSingleParams { poolKey, zeroForOne, exactAmountIn (uint128), hookData }.
          // A positional (poolKey, bool, uint128, bytes) encoding lays the
          // offsets out differently and the quoter reverts on it (verified
          // on-chain: positional → revert, single-struct → quote returned).
          inputs: [
            {
              type: 'tuple', components: [
                {
                  type: 'tuple', components: [
                    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }
                  ]
                },
                { type: 'bool' },
                { type: 'uint128' },
                { type: 'bytes' }
              ]
            }
          ],
          outputs: [{ type: 'uint256' }, { type: 'uint256' }]
        }],
        functionName: 'quoteExactInputSingle',
        args: [[[currency0, currency1, fee, tickSpacing, hooks], tokenIn === currency0, amountInWei, '0x']]
      });
      const res = await client.call({ to: quoter, data });
      if (!res.data || res.data === '0x') continue;
      const [amountOut] = decodeFunctionResult({
        abi: [{ name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }] }],
        functionName: 'quoteExactInputSingle',
        data: res.data
      });
      return amountOut;
    } catch {
      // Quoter/RPC unavailable — fall through to the next candidate, then to synthetic.
    }
  }
  return null;
}

// v4 PoolManager per network — used for the pool id derivation and echoed to
// the dashboard so it can validate hook permissions (getHookPermissions) on the
// right contract before a swap:
//   - unichain-sepolia: 0x00b036b58a818b1bc34d502d3fe730db729e62ac
//   - unichain:         0x1f98400000000000000000000000000000000004
//   - ethereum:         0x000000000004444c5dc75cB358380D2e3dE08A90
const V4_POOL_MANAGER_BY_NETWORK: Record<string, `0x${string}`> = {
  'unichain-sepolia': '0x00b036b58a818b1bc34d502d3fe730db729e62ac',
  unichain: '0x1f98400000000000000000000000000000000004',
  ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
};

// Decimals of the tokens the engine catalog can emit in MarketTrigger payloads
// (see TOKEN_CATALOG in crates/engine/src/main.rs and TOKEN_REGISTRY in
// apps/web/src/App.tsx — keep all three in sync). The trigger does not carry
// per-token decimals yet, so they are resolved from the known token addresses
// here. In the long run decimals should come from chain metadata or be added
// to the trigger payload.
//
// Per-network token catalog (Phase A — Unichain Sepolia playground):
// - Mainnet-addressed tokens: WETH, WBTC, USDC, LINK, UNI, DAI, LDO, AAVE
// - Unichain Sepolia mock tokens: mUSDT, mUSDC (deployed by user for testnet playground)
const TOKEN_DECIMALS: Record<string, number> = {
  // Mainnet-addressed tokens (used on Ethereum mainnet, Sepolia, and other chains)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18, // WETH
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8,  // WBTC
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,  // USDC (mainnet)
  '0x514910771af9ca656af840dff83e8264ecf986ca': 18, // LINK
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 18, // UNI
  '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': 18, // LDO
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 18, // AAVE
  // Unichain Sepolia mock tokens (Phase A playground)
  '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06': 6,  // mUSDT (mock USDT on Unichain Sepolia)
  '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860': 6,  // mUSDC (mock USDC on Unichain Sepolia)
};

// Human-readable symbol → address map for log/routing lookups when the caller
// already knows the ticker (e.g. the mock pair path). Mirrors the catalog in
// crates/engine/src/main.rs and TOKEN_REGISTRY in apps/web/src/App.tsx. Both
// must grow together: adding a symbol here without adding it to the engine/web
// mirrors leaves the rest of the pipeline blind to it.
const TOKEN_BY_SYMBOL: Record<string, `0x${string}`> = {
  // Mainnet-addressed tokens
  'WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'WBTC': '0x2260FAC5e5542a773Aa44fBCfeDf7C193bc2C599',
  'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'LINK': '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  'UNI': '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  'DAI': '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  'LDO': '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',
  'AAVE': '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  // Unichain Sepolia mock tokens (Phase A playground)
  'mUSDT': '0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06',
  'mUSDC': '0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860',
};

function getTokenDecimals(address: string): number {
  const decimals = TOKEN_DECIMALS[address.toLowerCase()];
  if (decimals === undefined) {
    throw new Error(`Unknown token decimals for address ${address}. Add it to TOKEN_DECIMALS or include decimals in the trigger.`);
  }
  return decimals;
}

// Resolve the active network (label + normalized key) from the same sources the
// orchestrator's REST state uses: the UI-set RPC network via /api/rpc-config,
// then NETWORK_NAME, then the built-in default. Resolved per request so a late/updated .env is never cached
// at module load time (desktop sidecar cold starts, dev dotenv flooding later).
function resolveNetwork(trigger?: MarketTrigger): { net: string; networkLabel: string } {
  // If the trigger is for the Unichain Sepolia mock playground tokens (mUSDC/mUSDT),
  // force network to 'unichain-sepolia' so calldata is generated for Unichain Sepolia.
  if (trigger) {
    const pair = (trigger.pair || '').toUpperCase();
    const tokenInLower = (trigger.token_in || '').toLowerCase();
    const tokenOutLower = (trigger.token_out || '').toLowerCase();
    const isMockTokenIn = tokenInLower === '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860' || tokenInLower === '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06';
    const isMockTokenOut = tokenOutLower === '0xd1f4c92fa1436ab2d110a02df56224ed0a4f5860' || tokenOutLower === '0xe05454d256ce63ae75df334ec6e0f1dc3e972e06';
    if (pair.includes('MUSDC') || pair.includes('MUSDT') || isMockTokenIn || isMockTokenOut) {
      return { net: 'unichain-sepolia', networkLabel: 'UNICHAIN-SEPOLIA' };
    }
  }

  const configuredNetwork = rpcConfig && rpcConfig.configured ? rpcConfig.network : undefined;
  const resolvedNetwork = configuredNetwork || (process.env.NETWORK_NAME || 'sepolia');
  let net = resolvedNetwork.toLowerCase();
  // Sepolia testnet does not host Uniswap v4 Universal Router; default testnet v4 routes to unichain-sepolia.
  if (net === 'sepolia') {
    net = 'unichain-sepolia';
  }
  const networkLabel =
    net === 'unichain-sepolia' ? 'UNICHAIN-SEPOLIA' :
      net === 'unichain' ? 'UNICHAIN' :
        net === 'ethereum' ? 'ETHEREUM' :
          net.toUpperCase();
  return { net, networkLabel };
}

// Encodes a Uniswap v4 single-pool exact-input swap through the Universal
// Router. Command + action bytes and the PoolKey/params layout are verified
// against the official sources (see comments above and
// docs/reference/Uniswap-swap.md Path A). The UR's TAKE_ALL sends the output
// to msg.sender, so NO zero-address recipient patch is needed on the client.
function encodeV4SwapCalldata(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountInWei: bigint;
  amountOutMinWei: bigint;
  fee: number;
  tickSpacing: number;
  hooksAddress: `0x${string}`;
  deadline: bigint;
}): { calldata: `0x${string}`; poolId: `0x${string}`; poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }; zeroForOne: boolean } {
  const { tokenIn, tokenOut, amountInWei, amountOutMinWei, fee, tickSpacing, hooksAddress, deadline } = args;

  // v4 PoolKey: currencies sorted numerically (address hex string comparison
  // is equivalent for equal-length hex), fee (uint24), tickSpacing (int24),
  // hooks (address). The pool the swap targets is identified EXACTLY by this
  // tuple — fee/tickSpacing/hooks must match the deployed pool or the swap
  // reverts (or hits a different/nonexistent pool).
  const tokenInNorm = tokenIn.toLowerCase() as `0x${string}`;
  const tokenOutNorm = tokenOut.toLowerCase() as `0x${string}`;
  const [currency0, currency1] = [tokenInNorm, tokenOutNorm].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) as [`0x${string}`, `0x${string}`];
  const zeroForOne = tokenInNorm === currency0;
  const hooks = hooksAddress.toLowerCase() as `0x${string}`;

  const poolKey = { currency0, currency1, fee, tickSpacing, hooks };
  const poolKeyTypes = [
    { type: 'address' as const },
    { type: 'address' as const },
    { type: 'uint24' as const },
    { type: 'int24' as const },
    { type: 'address' as const }
  ];
  // Pool id = keccak256(abi.encode(PoolKey)) — the same hash the PoolManager
  // derives for `PoolId`. Computed offline for display/logging; it is also the
  // address-ish identifier used in explorer lookups on v4.
  const poolId = keccak256(
    encodeAbiParameters(poolKeyTypes, [currency0, currency1, fee, tickSpacing, hooks])
  );

  // Action 1: SWAP_EXACT_IN_SINGLE with IV4Router.ExactInputSingleParams:
  //   ExactInputSingleParams { PoolKey poolKey, bool zeroForOne,
  //     uint256 amountIn, uint256 amountOutMinimum, bytes hookData }
  //   ⚠️ The UR's v4 module decodes the action params as ONE struct:
  //   abi.decode(params, (ExactInputSingleParams)). Because the struct contains
  //   a dynamic member (bytes hookData), abi.encode(struct) = offset word +
  //   tail — NOT the same bytes as encoding the five fields positionally
  //   (which the decoder reads as a bogus tuple offset → revert). This was the
  //   root cause of every v4 swap-action revert on the playground router.
  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple', components: [
          { type: 'tuple', components: poolKeyTypes },
          { type: 'bool' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes' }
        ]
      }
    ],
    [[[currency0, currency1, fee, tickSpacing, hooks], zeroForOne, amountInWei, amountOutMinWei, '0x']]
  );

  // Action 2: SETTLE_ALL(currencyIn, amountIn) — the router pays the input
  // leg. ERC20 inputs are pulled via Permit2 (the client pre-approves).
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [tokenInNorm, amountInWei]
  );

  // Action 3: TAKE_ALL(currencyOut, amountOutMinimum) — sends the output leg
  // to msg.sender (the executing wallet). The pool swap enforces
  // amountOutMinimum, so the min-out slippage guard holds.
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [tokenOutNorm, amountOutMinWei]
  );

  const actions = `0x${[V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;
  const params: `0x${string}`[] = [swapParams, settleParams, takeParams];

  // inputs[0] = abi.encode(actions, params)
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, params]
  );

  const calldata = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_EXECUTE_ABI,
    functionName: 'execute',
    args: [UR_COMMAND_V4_SWAP as `0x${string}`, [v4Input], deadline]
  });

  return { calldata, poolId, poolKey, zeroForOne };
}

export async function getUniswapSwapData(
  trigger: MarketTrigger,
  action: 'BUY' | 'SELL',
  // Quantity in BASE-token units of the pair for BOTH directions (how much of
  // the base token is bought on BUY / sold on SELL). The quote side is derived
  // from the trigger price below.
  amountBase: number,
  maxSlippageBps: number
): Promise<UniswapSwapData> {
  const slippageMultiplier = 1 - maxSlippageBps / 10000;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 min deadline

  // Standard DEX direction, pair label is BASE/QUOTE (token_in = base,
  // token_out = quote, trigger price = quote per 1 base):
  //   BUY  BASE/QUOTE -> pay the QUOTE token, receive the BASE token
  //   SELL BASE/QUOTE -> pay the BASE token, receive the QUOTE token
  const baseToken = trigger.token_in;
  const quoteToken = trigger.token_out;
  const price = trigger.current_price > 0 ? trigger.current_price : 1;
  const isBuy = action === 'BUY';
  const tokenIn = isBuy ? quoteToken : baseToken;
  const tokenOut = isBuy ? baseToken : quoteToken;

  // Normalise to lowercase so the viem encoder never rejects non-checksummed
  // casing coming from the Rust simulator (EIP-55 must be exact for
  // isAddress/checksum validation, and the simulator may emit arbitrary casing).
  const tokenInNorm = tokenIn.toLowerCase() as `0x${string}`;
  const tokenOutNorm = tokenOut.toLowerCase() as `0x${string}`;

  const tokenInDecimals = getTokenDecimals(tokenIn);
  const tokenOutDecimals = getTokenDecimals(tokenOut);

  // Safety net for the mUSDT/mUSDC playground path. The Rust simulator emits
  // the real token addresses in token_in/token_out, but if any upstream layer
  // accidentally overwrites those fields with lowercased symbols for this pair,
  // fall back to the documented catalog addresses so the swap card still builds.
  const normalizedIn = tokenIn.toLowerCase();
  const normalizedOut = tokenOut.toLowerCase();
  const fallbackTokenIn = normalizedIn === 'musdt' ? TOKEN_BY_SYMBOL['mUSDT'] : tokenIn;
  const fallbackTokenOut = normalizedOut === 'musdc' ? TOKEN_BY_SYMBOL['mUSDC'] : tokenOut;
  const effectiveTokenIn = normalizedIn === 'musdt' || normalizedIn === 'musdc' || normalizedIn === 'mavax' || normalizedOut === 'musdt' || normalizedOut === 'musdc' || normalizedOut === 'mavax' ? fallbackTokenIn : tokenIn;
  const effectiveTokenOut = normalizedOut === 'mUSDC' || normalizedOut === 'musdc' || normalizedOut === 'mavax' || normalizedIn === 'mUSDC' || normalizedIn === 'musdc' || normalizedIn === 'mavax' ? fallbackTokenOut : tokenOut;
  const effectiveTokenInNorm = effectiveTokenIn.toLowerCase() as `0x${string}`;
  const effectiveTokenOutNorm = effectiveTokenOut.toLowerCase() as `0x${string}`;

  // Spend (amountIn) and receive (amountOut) in token units:
  //   BUY  -> spend amountBase * price (quote), receive ~amountBase (base)
  //   SELL -> spend amountBase (base),     receive ~amountBase * price (quote)
  const rawAmountIn = isBuy ? amountBase * price : amountBase;
  const rawExpectedOut = isBuy ? amountBase : amountBase * price;

  // Encode each side with its own token decimals (never hardcode parseEther:
  // inputs can be 6-decimal tokens like USDC, which parseEther would inflate
  // by 10^12). Round to the token's decimals so parseUnits never overflows.
  const amountInWei = parseUnits(
    Math.max(rawAmountIn, 0).toFixed(tokenInDecimals),
    tokenInDecimals
  );

  // Minimum expected output after slippage, encoded in tokenOut decimals
  const amountOutMinWei = parseUnits(
    Math.max(rawExpectedOut * slippageMultiplier, 0).toFixed(tokenOutDecimals),
    tokenOutDecimals
  );

  const { net, networkLabel } = resolveNetwork(trigger);

  // ── v4 route: Universal Router command encoding (the only route) ──────────
  {
    const envV4Override = process.env.UNISWAP_V4_ROUTER as `0x${string}` | undefined;
    const routerAddress = envV4Override || V4_ROUTER_BY_NETWORK[net];
    if (!routerAddress) {
      throw new Error(
        `Uniswap v4 is not supported on network "${net}" yet. ` +
        `Supported: ${Object.keys(V4_ROUTER_BY_NETWORK).join(', ')}. Change the network or override UNISWAP_V4_ROUTER.`
      );
    }
    const poolManager = V4_POOL_MANAGER_BY_NETWORK[net];
    const fee = routeConfig.v4Fee > 0 ? routeConfig.v4Fee : 2500;
    const tickSpacing = routeConfig.v4TickSpacing > 0 ? routeConfig.v4TickSpacing : 60;
    const hooksRaw = (routeConfig.v4HooksAddress || '').trim();
    const hooksAddress: `0x${string}` = /^0x[0-9a-fA-F]{40}$/.test(hooksRaw)
      ? (hooksRaw.toLowerCase() as `0x${string}`)
      : ('0x0000000000000000000000000000000000000000' as `0x${string}`);

    // Anchor the min-out to the real pool price: the simulator price (1.0 for
    // mUSDC/mUSDT) drifts from the deployed pool (tick -31 ≈ 0.9969), and a
    // synthetic min-out band reverts on-chain with V4TooLittleReceived. Fall
    // back to the synthetic band only when the quoter is unreachable.
    let effectiveMinOut = amountOutMinWei;
    let minOutLabel = 'minOut synthetic';
    if (V4_QUOTER_BY_NETWORK[net]) {
      const quoted = await quoteV4Output(
        net, effectiveTokenInNorm, effectiveTokenOutNorm, amountInWei, fee, tickSpacing, hooksAddress
      );
      if (quoted !== null) {
        effectiveMinOut = (quoted * BigInt(10000 - Math.min(maxSlippageBps, 9999))) / 10000n;
        minOutLabel = 'minOut live-quoted';
      }
    }

    const { calldata, poolId, zeroForOne } = encodeV4SwapCalldata({
      tokenIn: effectiveTokenInNorm,
      tokenOut: effectiveTokenOutNorm,
      amountInWei,
      amountOutMinWei: effectiveMinOut,
      fee,
      tickSpacing,
      hooksAddress,
      deadline
    });

    const hookLabel = hooksAddress === '0x0000000000000000000000000000000000000000'
      ? 'no hook'
      : `hook ${hooksAddress}`;
    const permissionLabel = hooksAddress !== '0x0000000000000000000000000000000000000000' && routeConfig.v4HookPermissions
      ? ` [${routeConfig.v4HookPermissions}]`
      : '';

    return {
      to_address: routerAddress,
      calldata,
      // v4 input legs are ERC20s in the current catalog (no native-ETH pool):
      // the UR pulls them via Permit2, so the tx carries no payable value.
      value_wei: effectiveTokenInNorm === '0x0000000000000000000000000000000000000000' ? amountInWei.toString() : '0',
      route_summary: `${trigger.pair} via Uniswap v4 Universal Router (${networkLabel}) | fee ${fee} · tick ${tickSpacing} · ${hookLabel}${permissionLabel} · ${minOutLabel}`,
      estimated_gas_units: 350000,
      router_name: `Uniswap v4 Universal Router (${networkLabel})`,
      wallet_chain_id: CHAIN_ID_BY_NETWORK[net],
      protocol: 'v4',
      token_in_address: effectiveTokenInNorm,
      amount_in_wei: amountInWei.toString(),
      permit2_address: PERMIT2_ADDRESS,
      v4_pool_manager_address: poolManager,
      v4_pool_id: poolId,
      hook_address: hooksAddress === '0x0000000000000000000000000000000000000000' ? undefined : hooksAddress,
      hook_permissions: routeConfig.v4HookPermissions || undefined
    };
  }
}