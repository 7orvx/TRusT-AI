// Smoke test for the v3/v4 route encoder (2026-09-09). Run with:
//   SERVER_PORT=3991 NETWORK_NAME=unichain-sepolia npx tsx scripts/smoke-v4.ts
// Importing uniswapApi.ts transitively loads index.ts (which starts the
// orchestrator), so this script force-exits after the assertions.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, keccak256 } from 'viem';
import { routeConfig } from '../src/index.js';
import { getUniswapSwapData } from '../src/uniswapApi.js';
import { MarketTrigger } from '../src/aiProvider.js';

const mUSDC = '0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860'; // base (token_in)
const mUSDT = '0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06'; // quote (token_out)

const trigger: MarketTrigger = {
  block_number: 19842100,
  block_hash: '0x' + 'ab'.repeat(32),
  pair: 'mUSDC/mUSDT',
  token_in: mUSDC,
  token_out: mUSDT,
  pool_address: '0x7a517eb3525cf73f408eb8e1c883441be7a5b857',
  current_price: 1.005,
  price_change_24h: 0.62,
  gas_price_gwei: 18.5,
  estimated_slippage_percent: 0.12,
  liquidity_depth_usd: 1_200_000,
  timestamp: new Date().toISOString()
};

const UR_EXECUTE_ABI = [
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

const V3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' }
        ],
        name: 'params',
        type: 'tuple'
      }
    ],
    name: 'exactInputSingle',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// ── v4 route ─────────────────────────────────────────────────────────────────
routeConfig.protocol = 'v4';
routeConfig.v4Fee = 2500;
routeConfig.v4TickSpacing = 60;
routeConfig.v4HooksAddress = '';
routeConfig.v4HookPermissions = '';

async function main() {
const v4 = await getUniswapSwapData(trigger, 'BUY', 0.05, 50);
assert(v4.protocol === 'v4', 'v4: protocol is v4');
assert(
  v4.to_address === '0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d',
  `v4: to_address is Unichain Sepolia Universal Router (got ${v4.to_address})`
);
assert(v4.permit2_address === '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'v4: permit2 address');

const decoded = decodeFunctionData({ abi: UR_EXECUTE_ABI, data: v4.calldata as `0x${string}` });
assert(decoded.functionName === 'execute', `v4: calldata decodes to UR execute (got ${decoded.functionName})`);
const [commands, inputs, deadline] = decoded.args;
assert(commands === '0x10', `v4: commands byte is V4_SWAP 0x10 (got ${commands})`);
assert(inputs.length === 1, 'v4: one command input');
assert(deadline > BigInt(Math.floor(Date.now() / 1000)), 'v4: deadline in the future');

// inputs[0] is a raw ABI-encoded tuple (bytes actions, bytes[] params), not
// function calldata — decode with decodeAbiParameters.
const [actionsHex, params] = decodeAbiParameters(
  [{ type: 'bytes' }, { type: 'bytes[]' }],
  inputs[0] as `0x${string}`
) as [`0x${string}`, `0x${string}`[]];
assert(actionsHex === '0x060c0f', `v4: actions = SWAP_EXACT_IN_SINGLE(0x06) SETTLE_ALL(0x0c) TAKE_ALL(0x0f) (got ${actionsHex})`);
assert(params.length === 3, 'v4: three action params');

// params[0] = ExactInputSingleParams (PoolKey, zeroForOne, amountIn,
// amountOutMinimum, hookData) — also a raw tuple, not function calldata.
// ExactInputSingleParams = (tuple PoolKey, bool, uint256, uint256, bytes) —
// the PoolKey is NESTED, so the decode ABI must mirror that nesting.
const [exactIn] = decodeAbiParameters(
  [
    {
      type: 'tuple',
      components: [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' }
          ]
        },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'hookData', type: 'bytes' }
      ]
    }
  ],
  params[0] as `0x${string}`
);
const p = exactIn as unknown as { poolKey: Record<string, unknown>; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData: string };
assert(
  (p.poolKey.currency0 as string).toLowerCase() === mUSDC.toLowerCase(),
  `v4: currency0 is mUSDC (sorted lower, got ${p.poolKey.currency0})`
);
assert(
  (p.poolKey.currency1 as string).toLowerCase() === mUSDT.toLowerCase(),
  `v4: currency1 is mUSDT (sorted higher, got ${p.poolKey.currency1})`
);
assert(p.poolKey.fee === 2500, `v4: fee 2500 (got ${p.poolKey.fee})`);
assert(p.poolKey.tickSpacing === 60, `v4: tickSpacing 60 (got ${p.poolKey.tickSpacing})`);
assert((p.poolKey.hooks as string) === '0x0000000000000000000000000000000000000000', 'v4: hooks zero (hookless pool)');
assert(p.zeroForOne === false, `v4: BUY mUSDC pays mUSDT → tokenIn=mUSDT=currency1 → zeroForOne=false (got ${p.zeroForOne})`);
assert(p.amountIn === BigInt(v4.amount_in_wei), 'v4: amountIn echoes amount_in_wei');
assert(p.hookData === '0x', 'v4: empty hookData');

// pool id = keccak256(abi.encode(PoolKey)) — recompute independently
const poolIdRecomputed = keccak256(
  encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' }
    ],
    [
      mUSDC.toLowerCase() as `0x${string}`,
      mUSDT.toLowerCase() as `0x${string}`,
      2500,
      60,
      '0x0000000000000000000000000000000000000000'
    ]
  )
);
assert(v4.v4_pool_id === poolIdRecomputed, 'v4: pool id = keccak256(abi.encode(PoolKey))');
assert(v4.route_summary.includes('Uniswap v4 Universal Router'), 'v4: route summary labels v4');

// ── v3 route (same pair) ─────────────────────────────────────────────────────
routeConfig.protocol = 'v3';
const v3 = await getUniswapSwapData(trigger, 'BUY', 0.05, 50);
assert(v3.protocol === 'v3', 'v3: protocol is v3');
assert(
  v3.to_address === '0xd1aae39293221b77b0c71fbd6dcb7ea29bb5b166',
  `v3: Unichain Sepolia targets real SwapRouter02 0xd1aae… (got ${v3.to_address})`
);
const v3Decoded = decodeFunctionData({ abi: V3_ABI, data: v3.calldata as `0x${string}` });
assert(v3Decoded.functionName === 'exactInputSingle', `v3: calldata decodes to exactInputSingle (got ${v3Decoded.functionName})`);
const v3Params = v3Decoded.args[0] as Record<string, unknown>;
assert((v3Params.tokenIn as string).toLowerCase() === mUSDT.toLowerCase(), 'v3: BUY pays quote token (mUSDT)');

console.log('\n✅ All v3/v4 encoding assertions passed.');
process.exit(0);
}

main();