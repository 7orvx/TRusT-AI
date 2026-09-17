// One-off viability check (dev-only): quotes WETH→USDC and USDC→WETH through
// the real Unichain Sepolia V4Quoter for the public hookless 0.05% pool, and
// reads live slot0/liquidity via StateView. If the quotes return > 0, the pool
// is swap-able end to end.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, keccak256, encodeAbiParameters } from 'viem';

const RPC = 'https://sepolia.unichain.org';
const QUOTER = '0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472';
const STATE_VIEW = '0xc199f1072a74d4e905aba1a84d9a45e2546b6222';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x31d0220469e10c4E71834a79b1f276d740d3768F';
const ZERO = '0x0000000000000000000000000000000000000000';
const FEE = 500, TICK_SPACING = 10;

const chain = { id: 1301, name: 'Unichain Sepolia', network: 'unichain-sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC) });

const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [WETH < USDC ? WETH : USDC, WETH < USDC ? USDC : WETH, FEE, TICK_SPACING, ZERO]
));
console.log('PoolId:', poolId);

// StateView getSlot0(bytes32) → (sqrtPriceX96, tick, protocolFee, lpFee)
const GET_SLOT0 = [{ name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }] }];
const GET_LIQ = [{ name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint128' }] }];
const s0raw = (await client.call({ to: STATE_VIEW, data: encodeFunctionData({ abi: GET_SLOT0, functionName: 'getSlot0', args: [poolId] }) })).data;
const s0 = decodeFunctionResult({ abi: GET_SLOT0, functionName: 'getSlot0', data: s0raw });
const [sqrtPriceX96, tick, , lpFee] = Array.isArray(s0) ? s0 : [s0.sqrtPriceX96, s0.tick, s0.protocolFee, s0.lpFee];
const liqraw = (await client.call({ to: STATE_VIEW, data: encodeFunctionData({ abi: GET_LIQ, functionName: 'getLiquidity', args: [poolId] }) })).data;
const liq = decodeFunctionResult({ abi: GET_LIQ, functionName: 'getLiquidity', data: liqraw });
console.log('slot0:', { sqrtPriceX96: String(Array.isArray(s0) ? s0[0] : s0.sqrtPriceX96), tick: String(tick), lpFee: String(lpFee) }, 'liquidity:', String(liq));

// Implied price: currency0=WETH(18), currency1=USDC(6) here.
const sqrt = BigInt(sqrtPriceX96);
const price1per0raw = (sqrt * sqrt) / (2n ** 128n); // token1 raw per token0 raw
console.log(`raw price (USDC-raw per WETH-wei): ${price1per0raw}`);
// human price: (raw1/1e6) per (raw0/1e18) → raw1 * 1e12 per 1 WETH
const human = Number(price1per0raw) / 1e6 * 1e12;
console.log(`implied price ≈ ${human.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC per WETH`);

// V4Quoter.quoteExactInputSingle(QuoteExactSingleParams{ poolKey, zeroForOne, exactAmount, hookData })
const QUOTE_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{
    type: 'tuple', components: [
      { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
      { type: 'bool' }, { type: 'uint128' }, { type: 'bytes' },
    ]
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}];
async function quote(amountIn, zeroForOne) {
  const data = encodeFunctionData({
    abi: QUOTE_ABI, functionName: 'quoteExactInputSingle',
    args: [[WETH < USDC ? [WETH, USDC, FEE, TICK_SPACING, ZERO] : [USDC, WETH, FEE, TICK_SPACING, ZERO], zeroForOne, amountIn, '0x']],
  });
  try {
    const r = await client.call({ to: QUOTER, data });
    const [out, gas] = decodeFunctionResult({ abi: QUOTE_ABI, functionName: 'quoteExactInputSingle', data: r.data });
    return { out, gas };
  } catch (e) { return { err: e.message.slice(0, 120) }; }
}

const ONE_ETH = 10n ** 18n;
const q1 = await quote(ONE_ETH, true);   // WETH is currency0 → zeroForOne=true sells WETH for USDC
console.log(`\nQuote 1 WETH → USDC:`, q1.out !== undefined ? `${(Number(q1.out) / 1e6).toLocaleString()} USDC (gas ${q1.gas})` : q1.err);
const q2 = await quote(10n ** 8n, false); // 1 USDC (6dp) → WETH
console.log(`Quote 1 USDC → WETH:`, q2.out !== undefined ? `${(Number(q2.out) / 1e18).toFixed(8)} WETH (gas ${q2.gas})` : q2.err);
console.log('\nVIABLE:', q1.out !== undefined && q1.out > 0n ? 'YES — pool is swap-able' : 'NO');
