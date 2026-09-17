// One-off identification pass (dev-only): identifies the tokens seen in the
// Initialize-event scan and lists hookless WETH-involving pools with implied
// price + live liquidity (via StateView) so we can pick the public test pool.
import { createPublicClient, http, decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, encodeAbiParameters } from 'viem';

const RPC = 'https://sepolia.unichain.org';
const POOL_MANAGER = '0x00b036b58a818b1bc34d502d3fe730db729e62ac';
const STATE_VIEW = '0xc199f1072a74d4e905aba1a84d9a45e2546b6222';
const INIT_TOPIC = '0x908879ad15a41746863a49137286126d8db4c315f026657f8ab5b6116ff34b81';
const WETH = '0x4200000000000000000000000000000000000006';
const ZERO = '0x0000000000000000000000000000000000000000';
const MOCK_POOL_ID = '0xa57deccfba1974a0e6ee9a2eebe6e883093326743288e2784610715bf7e62752';

const chain = { id: 1301, name: 'Unichain Sepolia', network: 'unichain-sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC) });

const SYMBOL = [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }];
const SYMBOL_BYTES32 = [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }];
const DECIMALS = [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }];

async function identify(addr) {
  if (addr.toLowerCase() === WETH.toLowerCase()) return { symbol: 'WETH(canonical)', decimals: 18 };
  if (addr === ZERO) return { symbol: 'ETH(native)', decimals: 18 };
  const data = encodeFunctionData({ abi: SYMBOL, functionName: 'symbol' });
  try {
    const r = await client.call({ to: addr, data });
    return { symbol: decodeFunctionResult({ abi: SYMBOL, functionName: 'symbol', data: r.data }), decimals: null };
  } catch {
    try {
      const r = await client.call({ to: addr, data: encodeFunctionData({ abi: SYMBOL_BYTES32, functionName: 'symbol' }) });
      const raw = decodeFunctionResult({ abi: SYMBOL_BYTES32, functionName: 'symbol', data: r.data });
      return { symbol: Buffer.from(raw.slice(2), 'hex').toString().replace(/\0+$/, ''), decimals: null };
    } catch { return { symbol: '?', decimals: null }; }
  }
}
async function decimals(addr) {
  try {
    const r = await client.call({ to: addr, data: encodeFunctionData({ abi: DECIMALS, functionName: 'decimals' }) });
    return decodeFunctionResult({ abi: DECIMALS, functionName: 'decimals', data: r.data });
  } catch { return null; }
}

// Tokens seen paired with WETH in the scan — identify each.
const CANDIDATES = [
  '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  '0x2D3EfCD607B22B839cb1F85105ae3C26880dA1aF',
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  '0x078D782B760474A361ddA0Af3839290b0EF63b3d',
  '0xDAe1dEe023eea449357Aa3FF758a913C36D41953',
  '0xCFBF78D8C69f12ba38a7Bf5bd23f54FAf9c69765',
  '0xDFe9b0627e0ec2b653FaDe125421cc32575631FC',
  '0x1Fa19e9039302Cef7Eb2Eb80657B2A53C951e795',
];
console.log('=== TOKEN IDENTIFICATION ===');
for (const c of CANDIDATES) {
  const id = await identify(c);
  const d = id.decimals ?? await decimals(c);
  console.log(`${c} → ${id.symbol} (decimals: ${d ?? '?'})`);
}

// Re-scan (deploy block ~2.5M; scan from 2_000_000 to keep this pass fast) for
// hookless WETH pools only.
const latest = await client.getBlockNumber();
let lo = 2_000_000n, hi = latest;
const pools = [];
const CHUNK = 10000n, CONC = 6;
const chunks = [];
for (let from = lo; from <= hi; from += CHUNK) {
  const to = from + CHUNK - 1n > hi ? hi : from + CHUNK - 1n;
  chunks.push([from, to]);
}
for (let i = 0; i < chunks.length; i += CONC) {
  const batch = chunks.slice(i, i + CONC);
  const res = await Promise.all(batch.map(([f, t]) => client.getLogs({ address: POOL_MANAGER, topics: [INIT_TOPIC], fromBlock: f, toBlock: t }).catch(() => [])));
  for (const logs of res) for (const log of logs) {
    try {
      const ev = decodeEventLog({
        abi: [{ type: 'event', name: 'Initialize', inputs: [
          { name: 'id', type: 'bytes32', indexed: true },
          { name: 'currency0', type: 'address', indexed: true },
          { name: 'currency1', type: 'address', indexed: true },
          { name: 'fee', type: 'uint24', indexed: false },
          { name: 'tickSpacing', type: 'int24', indexed: false },
          { name: 'hooks', type: 'address', indexed: false },
          { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
          { name: 'tick', type: 'int24', indexed: false },
        ] }],
        data: log.data, topics: log.topics,
      });
      if (ev.args.hooks === ZERO) pools.push(ev.args);
    } catch { /* skip */ }
  }
}
const wethPools = pools.filter((p) => [p.currency0, p.currency1].some((c) => c.toLowerCase() === WETH.toLowerCase()));
console.log(`\n=== HOOKLESS WETH POOLS: ${wethPools.length} (from block 2M) ===`);

// StateView getLiquidity(bytes32 poolId) → uint128
const GET_LIQ = [{ name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint128' }] }];
async function liquidity(poolId) {
  try {
    const r = await client.call({ to: STATE_VIEW, data: encodeFunctionData({ abi: GET_LIQ, functionName: 'getLiquidity', args: [poolId] }) });
    return decodeFunctionResult({ abi: GET_LIQ, functionName: 'getLiquidity', data: r.data });
  } catch { return null; }
}

const seen = new Map();
for (const p of wethPools) {
  // PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
  const poolId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks]
  ));
  const liq = await liquidity(poolId);
  // implied price of currency1 per currency0 (1=sqrt(1):1 ratio → 1e0)
  const ratio = (p.currency0 === ZERO || p.currency1 === ZERO) ? null : null;
  const key = `${p.currency0}/${p.currency1}/fee${p.fee}/tick${p.tickSpacing}`;
  const entry = seen.get(key) ?? { count: 0, maxLiq: 0n, example: p, poolId };
  entry.count++;
  if (liq && liq > entry.maxLiq) { entry.maxLiq = liq; entry.poolId = poolId; entry.example = p; }
  seen.set(key, entry);
}
for (const [key, e] of seen) {
  const withWeth = [e.example.currency0, e.example.currency1].some((c) => c.toLowerCase() === WETH.toLowerCase());
  console.log(`${key} | liq=${e.maxLiq} | poolId=${e.poolId} | sqrt@init=${e.example.sqrtPriceX96} tick=${e.example.tick}${withWeth ? '' : ' [no WETH?]'}`);
}
console.log(`\n[OUR MOCK] still present: ${pools.some((p) => p.currency0.toLowerCase().includes('d1f4')) ? 'yes' : 'scanned-from-2M (mock created before)'}`);
