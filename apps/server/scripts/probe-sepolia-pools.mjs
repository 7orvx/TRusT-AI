// Fast (no block scanning) Sepolia v4 pool probe: candidate token pairs x
// standard fee/tick tiers, checked directly against StateView. Seconds, not
// minutes. Reuses the same poolId derivation as apps/server/src/uniswapApi.ts.
import { createPublicClient, http, keccak256, encodeAbiParameters, decodeFunctionResult, encodeFunctionData } from 'viem';

const RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';
const STATE_VIEW = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C';

const ETH = '0x0000000000000000000000000000000000000000';
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'; // official Uniswap Sepolia WETH9
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // Circle Sepolia USDC
const USDT = '0xaA8E23Fb10791994442A64b286079b19800a12Cb'; // candidate Sepolia USDT

const client = createPublicClient({ transport: http(RPC, { timeout: 10000 }) });

const ERC20_SYM_ABI = [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }];
const LIQ_ABI = [{ name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint128' }] }];
const SLOT0_ABI = [{ name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [
  { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
  { name: 'protocolFee', type: 'uint32' }, { name: 'lpFee', type: 'uint24' },
] }];

async function symbolOf(addr) {
  try {
    const data = encodeFunctionData({ abi: ERC20_SYM_ABI, functionName: 'symbol' });
    const res = await client.call({ to: addr, data });
    const dec = decodeFunctionResult({ abi: ERC20_SYM_ABI, functionName: 'symbol', data: res.data });
    return Array.isArray(dec) ? dec[0] : dec;
  } catch (e) {
    return `<err: ${(e.message || '').slice(0, 60)}>`;
  }
}

console.log('chainId:', await client.getChainId());
console.log('WETH :', await symbolOf(WETH));
console.log('USDC :', await symbolOf(USDC));
console.log('USDT :', await symbolOf(USDT));

const TIERS = [
  [100, 1], [500, 10], [500, 60], [3000, 60], [3000, 120], [10000, 200], [2500, 25],
];
const PAIRS = [
  ['nativeETH/USDC', ETH, USDC],
  ['WETH/USDC', WETH, USDC],
];

function poolIdOf(c0, c1, fee, tickSpacing) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, fee, tickSpacing, '0x0000000000000000000000000000000000000000'],
  ));
}

for (const [label, a, b] of PAIRS) {
  const c0 = a.toLowerCase() < b.toLowerCase() ? a : b;
  const c1 = a.toLowerCase() < b.toLowerCase() ? b : a;
  for (const [fee, ts] of TIERS) {
    const pid = poolIdOf(c0, c1, fee, ts);
    try {
      const res = await client.call({ to: STATE_VIEW, data: encodeFunctionData({ abi: LIQ_ABI, functionName: 'getLiquidity', args: [pid] }) });
      const dec = decodeFunctionResult({ abi: LIQ_ABI, functionName: 'getLiquidity', data: res.data });
      const liq = Array.isArray(dec) ? dec[0] : dec;
      if (liq > 0n) {
        let price = 'n/a';
        try {
          const s0 = await client.call({ to: STATE_VIEW, data: encodeFunctionData({ abi: SLOT0_ABI, functionName: 'getSlot0', args: [pid] }) });
          const d0 = decodeFunctionResult({ abi: SLOT0_ABI, functionName: 'getSlot0', data: s0.data });
          const sq = Array.isArray(d0) ? d0[0] : d0.sqrtPriceX96;
          const raw = (Number(sq) / Number(1n << 96n)) ** 2;
          price = raw.toPrecision(6);
        } catch { price = 'slot0-err'; }
        console.log(`POOL ${label} fee=${fee} tick=${ts} liq=${liq} poolId=${pid} price0per1=${price}`);
      }
    } catch (e) {
      console.log(`ERR ${label} ${fee}/${ts}: ${(e.message || '').slice(0, 80)}`);
    }
  }
}
console.log('probe done');
