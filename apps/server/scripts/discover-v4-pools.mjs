// One-off discovery script (dev-only, NOT part of the server build):
// scans the Unichain Sepolia v4 PoolManager for Initialize events and lists
// every pool ever created — we use it to find a PUBLIC WETH/USDC pool so the
// dashboard can offer a real end-to-end testnet swap (no mock tokens).
//
// Strategy: binary-search the PoolManager deploy block (eth_getCode), then
// scan forward in 10k-block chunks (this RPC's max range) with modest
// concurrency.
//
// Usage: node scripts/discover-v4-pools.mjs   (cwd: apps/server)
import { createPublicClient, http, decodeEventLog } from 'viem';

const RPC = 'https://sepolia.unichain.org';
const POOL_MANAGER = '0x00b036b58a818b1bc34d502d3fe730db729e62ac';
// v4-core Initialize(address,address,uint24,int24,address,uint160,int24) event
const INIT_TOPIC = '0x908879ad15a41746863a49137286126d8db4c315f026657f8ab5b6116ff34b81';
const WETH_CANDIDATE = '0x4200000000000000000000000000000000000006'; // OP-Stack canonical WETH
const MOCK_POOL_ID = '0xa57deccfba1974a0e6ee9a2eebe6e883093326743288e2784610715bf7e62752';

const chain = {
  id: 1301,
  name: 'Unichain Sepolia',
  network: 'unichain-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const client = createPublicClient({ chain, transport: http(RPC) });

const latest = await client.getBlockNumber();
console.log(`Chain ${await client.getChainId()} — latest block ${latest}`);

// ── 1. Binary-search the deploy block (first block where PM has code) ──────
let lo = 0n;
let hi = latest;
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  const code = await client.getBytecode({ address: POOL_MANAGER, blockNumber: mid });
  if (code && code !== '0x') hi = mid; else lo = mid + 1n;
}
const deployBlock = lo;
console.log(`PoolManager deployed at block ~${deployBlock}`);

// ── 2. Scan [deployBlock, latest] in 10k chunks, 4 concurrent ──────────────
const pools = [];
const CHUNK = 10000n;
const CONCURRENCY = 4;
const chunks = [];
for (let from = deployBlock; from <= latest; from += CHUNK) {
  const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
  chunks.push([from, to]);
}
console.log(`Scanning ${chunks.length} chunks of ${CHUNK} blocks…`);

let done = 0;
for (let i = 0; i < chunks.length; i += CONCURRENCY) {
  const batch = chunks.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(async ([from, to]) => {
    try {
      return await client.getLogs({
        address: POOL_MANAGER,
        topics: [INIT_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.warn(`chunk ${from}-${to}: ${(e).message?.slice(0, 60)}`);
      return [];
    }
  }));
  for (const logs of results) {
    for (const log of logs) {
      try {
        const ev = decodeEventLog({
          abi: [{
            type: 'event',
            name: 'Initialize',
            inputs: [
              { name: 'id', type: 'bytes32', indexed: true },
              { name: 'currency0', type: 'address', indexed: true },
              { name: 'currency1', type: 'address', indexed: true },
              { name: 'fee', type: 'uint24', indexed: false },
              { name: 'tickSpacing', type: 'int24', indexed: false },
              { name: 'hooks', type: 'address', indexed: false },
              { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
              { name: 'tick', type: 'int24', indexed: false },
            ],
          }],
          data: log.data,
          topics: log.topics,
        });
        pools.push(ev.args);
      } catch {
        /* undecodable log — skip */
      }
    }
  }
  done += batch.length;
  if (done % 400 < CONCURRENCY) console.log(`  …${done}/${chunks.length} chunks, ${pools.length} pools`);
}

console.log(`\nTotal pools initialized: ${pools.length}`);
const wethFlag = (a) => (a.toLowerCase() === WETH_CANDIDATE ? '<WETH?>' : '');
const isMock = (id) => id.toLowerCase() === MOCK_POOL_ID.toLowerCase();
// Print mock + WETH-involving pools in full; aggregate the rest.
const interesting = pools.filter((p) => isMock(p.id) || [p.currency0, p.currency1].some((c) => c.toLowerCase() === WETH_CANDIDATE));
console.log(`\n=== INTERESTING (mock or WETH-involving): ${interesting.length} ===`);
for (const p of interesting) {
  console.log(
    `${isMock(p.id) ? '[OUR MOCK] ' : ''}${p.id} | c0=${p.currency0} ${wethFlag(p.currency0)} c1=${p.currency1} ${wethFlag(p.currency1)} | fee=${p.fee} tick=${p.tickSpacing} hooks=${p.hooks} | sqrtPriceX96=${p.sqrtPriceX96} tick=${p.tick}`
  );
}
const others = pools.length - interesting.length;
if (others > 0 && others <= 40) {
  console.log('\n=== OTHER POOLS ===');
  for (const p of pools) {
    if (isMock(p.id) || [p.currency0, p.currency1].some((c) => c.toLowerCase() === WETH_CANDIDATE)) continue;
    console.log(`${p.id} | c0=${p.currency0} c1=${p.currency1} | fee=${p.fee} tick=${p.tickSpacing} hooks=${p.hooks}`);
  }
} else if (others > 0) {
  console.log(`(${others} other pools omitted)`);
}
