import { routeConfig } from '../src/index.js';
import { getUniswapSwapData } from '../src/uniswapApi.js';

async function main() {
  routeConfig.protocol = 'v4';
  routeConfig.v4Fee = 2500;
  routeConfig.v4TickSpacing = 60;
  routeConfig.v4HooksAddress = '';
  const trigger: any = {
    block_number: 19842100,
    block_hash: '0x' + 'ab'.repeat(32),
    pair: 'mUSDC/mUSDT',
    token_in: '0xD1F4C92Fa1436aB2D110a02Df56224Ed0A4f5860',
    token_out: '0xE05454d256cE63ae75DF334ec6e0f1DC3e972E06',
    pool_address: '0x7a517eb3525cf73f408eb8e1c883441be7a5b857',
    current_price: 1.005,
    price_change_24h: 0.62,
    gas_price_gwei: 18.5,
    estimated_slippage_percent: 0.12,
    liquidity_depth_usd: 1200000,
    timestamp: new Date().toISOString()
  };
  const v4 = await getUniswapSwapData(trigger, 'BUY', 0.05, 50);
  console.log('v4_pool_id:', v4.v4_pool_id);
  console.log('calldata:', v4.calldata);
  // The execute args decode: commands(0x10), inputs[0] (tuple: bytes actions, bytes[] params)
  const input0Hex = v4.calldata.slice(10); // strip execute selector
  console.log('--- words of execute args (first 8) ---');
  for (let i = 0; i < 8; i++) {
    console.log(i, input0Hex.slice(i * 64, i * 64 + 64));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });