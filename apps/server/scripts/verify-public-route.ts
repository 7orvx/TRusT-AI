// One-off end-to-end verification (dev-only): drives the REAL production
// encoder (getUniswapSwapData) with mainnet-addressed triggers — exactly what
// the Rust engine streams — and checks the public testnet pool routes end to
// end on BOTH networks:
//   • Sepolia (11155111): public NATIVE-ETH/USDC pool — SELL must carry
//     value_wei > 0 (native input) and BUY must quote via Permit2-style
//     ERC20 input; poolId must be the native sentinel PoolKey.
//   • Unichain Sepolia (1301): public WETH/USDC pool (regression).
// Also drives getLivePairPrice for the Sepolia pair.
//
// Run: cd apps/server && npx esbuild scripts/verify-public-route.ts --bundle \
//        --platform=node --format=cjs --outfile=scripts/.verify.cjs && \
//      SERVER_PORT=3999 node scripts/.verify.cjs
import { getUniswapSwapData, symbolForAddress, getPublicPoolKey } from '../src/uniswapApi.js';
import { getLivePairPrice } from '../src/poolPrice.js';
import type { MarketTrigger } from '../src/aiProvider.js';

// Selects the pair network EXACTLY like the dashboard does: a settings push
// (the /api/settings handler applies rpcNetwork standalone into the in-memory
// selectedNetwork — the route resolver's source of truth).
async function selectNetwork(serverUrl: string, pair: string, network: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair, rpcNetwork: network }),
  });
  if (!res.ok) throw new Error(`settings push failed: ${res.status} ${await res.text()}`);
}

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const SEPOLIA_POOL_ID = '0x8439998c1a5d4ec8c7ec9b02eb25f5f41e3eb2d41eb2bef710778a38ec12eb9d';
const UNICHAIN_POOL_ID = '0x71fba4ef34765b317417131bb7cef92bd4c43405babf9386cacdd10cf8641422';
const SEPOLIA_UR = '0x7dfd4f31be6814d2906bde155c3e1b146eac1468';
const UNICHAIN_UR = '0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d';

function trigger(pair: string, tokenIn: string, tokenOut: string, price: number): MarketTrigger {
  return {
    block_number: 19843000,
    block_hash: '0xverify',
    pair,
    token_in: tokenIn,
    token_out: tokenOut,
    pool_address: '0x0000000000000000000000000000000000000000',
    current_price: price,
    price_change_24h: 1.2,
    gas_price_gwei: 0.02,
    estimated_slippage_percent: 0.3,
    liquidity_depth_usd: 1_000_000,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const SERVER = `http://127.0.0.1:${process.env.SERVER_PORT || 3999}`;
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}  ${detail}`);
    if (!ok) failures++;
  };

  console.log('── Sepolia · public NATIVE-ETH/USDC pool ─────────────────────');
  await selectNetwork(SERVER, 'WETH/USDC', 'sepolia');
  console.log('PPK sepolia  :', JSON.stringify(getPublicPoolKey('sepolia', 'WETH', 'USDC')));
  const sepoliaLive = await getLivePairPrice('WETH/USDC', 'sepolia', 3000);
  console.log('LIVE PRICE   :', sepoliaLive.price, '(source:', sepoliaLive.source + ')');
  check('live price source=pool', sepoliaLive.source === 'pool', `source=${sepoliaLive.source} price=${sepoliaLive.price}`);

  // SELL: pay NATIVE ETH (engine emits mainnet WETH → mapped to sentinel)
  const sell = await getUniswapSwapData(trigger('WETH/USDC', WETH_MAINNET, USDC_MAINNET, 3200), 'SELL', 0.001, 100);
  console.log('SELL router  :', sell.to_address, '| chain', sell.wallet_chain_id, '| value_wei', sell.value_wei);
  console.log('SELL route   :', sell.route_summary);
  console.log('SELL poolId  :', sell.v4_pool_id);
  check('SELL router = Sepolia UR 2.1.1', sell.to_address.toLowerCase() === SEPOLIA_UR, sell.to_address);
  check('SELL chain id 11155111', sell.wallet_chain_id === 11155111, String(sell.wallet_chain_id));
  check('SELL token_in = native sentinel', sell.token_in_address === NATIVE_ETH, sell.token_in_address);
  check('SELL carries msg.value', BigInt(sell.value_wei) > 0n, `value_wei=${sell.value_wei}`);
  check('SELL poolId = native ETH/USDC 1%/200', sell.v4_pool_id === SEPOLIA_POOL_ID, sell.v4_pool_id);
  check('SELL minOut live-quoted', sell.route_summary.includes('minOut live-quoted'), sell.route_summary.split('| ')[1] ?? '');

  // BUY: pay USDC (ERC20 → Permit2), receive native ETH
  const buy = await getUniswapSwapData(trigger('WETH/USDC', WETH_MAINNET, USDC_MAINNET, 3200), 'BUY', 0.001, 100);
  console.log('BUY  route   :', buy.route_summary);
  check('BUY token_in = Sepolia USDC', buy.token_in_address === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', buy.token_in_address);
  check('BUY no msg.value (ERC20 via Permit2)', BigInt(buy.value_wei) === 0n, `value_wei=${buy.value_wei}`);
  check('BUY minOut live-quoted', buy.route_summary.includes('minOut live-quoted'), buy.route_summary.split('| ')[1] ?? '');

  console.log('── Unichain Sepolia · public WETH/USDC pool (regression) ─────');
  await selectNetwork(SERVER, 'WETH/USDC', 'unichain-sepolia');
  const uni = await getUniswapSwapData(trigger('WETH/USDC', WETH_MAINNET, USDC_MAINNET, 3000), 'BUY', 0.001, 100);
  console.log('BUY  router  :', uni.to_address, '| chain', uni.wallet_chain_id);
  check('router = Unichain UR', uni.to_address === UNICHAIN_UR, uni.to_address);
  check('chain id 1301', uni.wallet_chain_id === 1301, String(uni.wallet_chain_id));
  check('poolId = 0x71fba4ef…', uni.v4_pool_id === UNICHAIN_POOL_ID, uni.v4_pool_id);

  console.log(`\nE2E RESULT   : ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
