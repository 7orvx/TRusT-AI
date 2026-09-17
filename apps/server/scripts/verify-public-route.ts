// One-off end-to-end verification (dev-only): drives the REAL production
// encoder (getUniswapSwapData) with a mainnet-addressed WETH/USDC trigger —
// exactly what the Rust engine streams — and checks the Unichain Sepolia
// public pool route end to end (token mapping, PoolKey, live-quoted minOut).
// Also drives getLivePairPrice for the same pair.
//
// Run: cd apps/server && npx esbuild scripts/verify-public-route.ts --bundle \
//        --platform=node --format=cjs --outfile=scripts/.verify.cjs && \
//      SERVER_PORT=3999 node scripts/.verify.cjs
import { getUniswapSwapData, symbolForAddress, getPublicPoolKey } from '../src/uniswapApi.js';
import { getLivePairPrice } from '../src/poolPrice.js';
import type { MarketTrigger } from '../src/aiProvider.js';

const trigger: MarketTrigger = {
  block_number: 19843000,
  block_hash: '0xverify',
  pair: 'WETH/USDC',
  token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // mainnet WETH (engine catalog)
  token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // mainnet USDC (engine catalog)
  pool_address: '0x0000000000000000000000000000000000000000',
  current_price: 3000,
  price_change_24h: 1.2,
  gas_price_gwei: 0.02,
  estimated_slippage_percent: 0.3,
  liquidity_depth_usd: 1_000_000,
  timestamp: new Date().toISOString(),
};

async function main() {
console.log('SYMBOLS      :', symbolForAddress(trigger.token_in), '/', symbolForAddress(trigger.token_out));
console.log('PPK direct   :', JSON.stringify(getPublicPoolKey('unichain-sepolia', 'WETH', 'USDC')));
const live = await getLivePairPrice('WETH/USDC', 'unichain-sepolia', 3000);
console.log('LIVE PRICE  :', live.price, '(source:', live.source + ')');

const swap = await getUniswapSwapData(trigger, 'BUY', 0.001, 100);
console.log('router      :', swap.to_address);
console.log('chain id    :', swap.wallet_chain_id);
console.log('token_in    :', swap.token_in_address, '(expect testnet USDC 0x31d0…768f)');
console.log('amount_in   :', swap.amount_in_wei, '(expect 1000e6 raw USDC for 0.001 WETH BUY @ $3000)');
console.log('pool id     :', swap.v4_pool_id, '(expect 0x71fba4ef…)');
console.log('pool manager:', swap.v4_pool_manager_address);
console.log('hook        :', swap.hook_address ?? 'none');
console.log('route       :', swap.route_summary);

const ok =
  swap.to_address === '0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d' &&
  swap.wallet_chain_id === 1301 &&
  swap.token_in_address === '0x31d0220469e10c4e71834a79b1f276d740d3768f' &&
  swap.v4_pool_id === '0x71fba4ef34765b317417131bb7cef92bd4c43405babf9386cacdd10cf8641422' &&
  swap.route_summary.includes('fee 500') && swap.route_summary.includes('tick 10') &&
  (swap.route_summary.includes('minOut live-quoted') || swap.route_summary.includes('minOut synthetic'));
console.log('\nE2E RESULT  :', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
