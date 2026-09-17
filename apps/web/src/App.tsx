import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Activity,
  Cpu,
  Zap,
  ShieldAlert,
  Brain,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  PauseCircle,
  PlayCircle,
  Terminal as TerminalIcon,
  ExternalLink,
  Settings,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Clock,
  Filter,
  ChevronDown,
  XCircle,
  Wallet,
  Eye,
  EyeOff,
  KeyRound,
  Wifi,
  Check
} from 'lucide-react';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { WalletProviders } from './wallet/WalletProviders';
import {
  appKit,
  getActiveProvider,
  waitForWalletConnection,
  useActiveAccount,
  useActiveEnsName,
  useWalletConnect,
  useWalletDisconnect,
  useSwitchChainHook,
  useActiveChainId,
  CHAIN_NAMES,
  type EIP1193,
} from './wallet/config';
import { getNetworkBadgeInfo, CHAIN_NAMES as WAGMI_CHAIN_NAMES } from './wallet/NetworkSelector';
import { PICKER_NETWORKS, networkKeyForChainId, chainIdForNetworkKey, pairSupportedOnChain, tokenSupportedOnChain, isMockPair, MOCK_PAIR_CHAIN_ID, pickNetworkForPair, pickerNetworkLabel, PAIR_STORAGE_KEY, PAIR_INSTANCE_KEY, MAX_DYNAMIC_TOKENS_PER_TAB } from './pairNetworks';
import {
  getTokenPrice,
  getUsdPrice,
  getUsdPriceMap,
  getUsdChange24h,
  fetchTopTokens,
  type TopToken,
  formatTruncatedAddress,
  getTokenBalance,
  getNativeBalance,
  getBlockNumber,
  getChainName,
  isTestnet,
  TOKENS,
  TOKEN_LOGOS,
} from './wallet/priceFetcher';



// Minimal Permit2 ABI (approve + allowance) used by the v4 execution path. On
// v4 the Universal Router pulls ERC20 inputs via Permit2.transferFrom, so the
// dashboard must approve (token → Permit2) with a standard ERC20 approve and
// then (Permit2 → Universal Router) with permit2.approve(token, router, amount,
// expiration) before executing the swap.
const PERMIT2_ABI = [
  {
    type: 'function' as const,
    name: 'approve' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' }
    ],
    outputs: [{ name: 'approved', type: 'bool' }]
  },
  {
    type: 'function' as const,
    name: 'allowance' as const,
    stateMutability: 'view' as const,
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' }
    ]
  }
] as const;

// v4 PoolManager getHookPermissions ABI - used to validate a hook address
// BEFORE it is accepted as part of the PoolKey (Phase C of
// docs/design/uniswap-routing-v3-v4-hooks.md). The result is decoded manually
// (word slicing) because the HookPermissions struct grew across v4-core
// versions; the first 8 flags are stable.
const POOL_MANAGER_GET_HOOK_PERMISSIONS_ABI = [
  {
    type: 'function' as const,
    name: 'getHookPermissions' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'hooks', type: 'address' }],
    outputs: [
      {
        name: 'permissions',
        type: 'tuple',
        components: [
          { name: 'beforeInitialize', type: 'bool' },
          { name: 'afterInitialize', type: 'bool' },
          { name: 'beforeAddLiquidity', type: 'bool' },
          { name: 'afterAddLiquidity', type: 'bool' },
          { name: 'beforeRemoveLiquidity', type: 'bool' },
          { name: 'afterRemoveLiquidity', type: 'bool' },
          { name: 'beforeSwap', type: 'bool' },
          { name: 'afterSwap', type: 'bool' }
        ]
      }
    ]
  }
] as const;

// v4 PoolManager per chain (mirrors V4_POOL_MANAGER_BY_NETWORK server-side,
// official Uniswap deployment tables) — used to validate hooks on the correct
// contract and to display the v4 pool id from the swap data.
const V4_POOL_MANAGER_BY_CHAIN: Record<number, string> = {
  1301: '0x00b036b58a818b1bc34d502d3fe730db729e62ac', // Unichain Sepolia
  130: '0x1f98400000000000000000000000000000000004',  // Unichain
  1: '0x000000000004444c5dc75cB358380D2e3dE08A90',    // Ethereum
  42161: '0x360e68faccca8ca495c1b759fd9eee466db9fb32', // Arbitrum One
  8453: '0x498581ff718922c3f8e6a244956af099b2652b2b',  // Base
  137: '0x67366782805870060151383f4bbff9dab53e5cd6',   // Polygon PoS
};

// Hook lifecycle flag names (first 8 words of the HookPermissions struct, in
// declaration order — stable across v4-core versions).
const HOOK_PERMISSION_FLAGS = [
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap'
] as const;

// Decodes a getHookPermissions result without relying on a fixed ABI tuple
// length: the struct is a sequence of 32-byte bool words, and the first 8 are
// stable across v4-core versions (newer versions append more flags after).
function decodeHookPermissionFlags(rawHex: string): Record<string, boolean> {
  const hex = rawHex.startsWith('0x') ? rawHex.slice(2) : rawHex;
  const flags: Record<string, boolean> = {};
  HOOK_PERMISSION_FLAGS.forEach((name, i) => {
    const word = hex.slice(i * 64, i * 64 + 64);
    flags[name] = word.length === 64 && word.slice(-2) !== '00';
  });
  return flags;
}

// Shortens an address/hash for compact display (0x1234—abcd).
const shortAddr = (addr?: string) =>
  addr && addr.length > 10 ? `${addr.slice(0, 6)}—${addr.slice(-4)}` : addr || '';

// Minimal ERC-20 ABI for the allowance gate + approval tx that must precede a
// swap (Permit2 pulls the input token via transferFrom on the v4 route).
const ERC20_MIN_ABI = [
  {
    type: 'function' as const,
    name: 'allowance' as const,
    stateMutability: 'view' as const,
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: 'remaining', type: 'uint256' }]
  },
  {
    type: 'function' as const,
    name: 'approve' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: 'approved', type: 'bool' }]
  }
] as const;

// Polls eth_getTransactionReceipt until the tx is mined (or the timeout hits).
// Returns true only when the receipt reports status 0x1 (success).
async function waitForTransaction(provider: EIP1193, txHash: string, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const receipt: any = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
      if (receipt) return receipt.status === '0x1';
    } catch {
      // Provider not ready yet - keep polling.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// Normalizes an eth_sendTransaction result into a 0x-prefixed hash, or null.
function normalizeTxHash(result: unknown): string | null {
  const hash = typeof result === 'string' ? result : String(result);
  if (hash.startsWith('0x') || hash.length === 64) return hash.startsWith('0x') ? hash : `0x${hash}`;
  return null;
}

// Block explorer URL for a tx hash on the connected chain (falls back to
// Sepolia Etherscan when the chain is unknown/not connected).
function explorerTxUrl(chainId: number | undefined, txHash: string): string {
  if (chainId === 1301) return `https://sepolia.uniscan.xyz/tx/${txHash}`;
  if (chainId === 1) return `https://etherscan.io/tx/${txHash}`;
  if (chainId === 42161) return `https://arbiscan.io/tx/${txHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 137) return `https://polygonscan.com/tx/${txHash}`;
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

interface MarketTrigger {
  block_number: number;
  block_hash: string;
  pair: string;
  token_in: string;
  token_out: string;
  pool_address: string;
  current_price: number;
  price_change_24h: number;
  gas_price_gwei: number;
  estimated_slippage_percent: number;
  liquidity_depth_usd: number;
  timestamp: string;
}

interface UniswapSwapData {
  to_address: string;
  calldata: string;
  value_wei: string;
  route_summary: string;
  estimated_gas_units: number;
  router_name: string;
  // Route metadata (v4 route — mirrors apps/server/src/uniswapApi.ts). The
  // UR's TAKE_ALL sends the output to msg.sender, so there is no recipient
  // patch; token_in_address / amount_in_wei feed the Permit2 allowance gate.
  protocol?: 'v4';
  // Chain id the calldata targets (server-derived from the route network).
  // The chain guard compares this numerically against the wagmi chainId.
  wallet_chain_id?: number;
  token_in_address?: string;
  amount_in_wei?: string;
  permit2_address?: string;
  v4_pool_manager_address?: string;
  v4_pool_id?: string;
  hook_address?: string;
  hook_permissions?: string;
}

interface AIDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggested_amount_eth: number;
  max_slippage_bps: number;
  mev_risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  provider_used: string;
  timestamp: string;
  tx_hash_simulated?: string;
  uniswap_swap_data?: UniswapSwapData;
}

interface EventLog {
  id: string;
  trigger: MarketTrigger;
  decision: AIDecision;
  receivedAt: string;
}

// Shared token catalog shown in the pair builder and used to compose custom
// pairs. Keep in sync with TOKEN_CATALOG in crates/engine/src/main.rs and
// TOKEN_DECIMALS in apps/server/src/uniswapApi.ts (same symbols/addresses).
const TOKEN_REGISTRY = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, color: '#627eea' },
  { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2260FAC5e5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, color: '#f7931a' },
  { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, color: '#2775ca' },
  { symbol: 'LINK', name: 'Chainlink', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, color: '#2a5ada' },
  { symbol: 'UNI', name: 'Uniswap', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, color: '#ff007a' },
  { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, color: '#f5ac37' },
  { symbol: 'LDO', name: 'Lido DAO', address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18, color: '#00a3ff' },
  { symbol: 'AAVE', name: 'Aave', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, color: '#b6509e' },
  // NOTE: the Unichain Sepolia mock tokens (mUSDC/mUSDT) are intentionally NOT
  // selectable here — they have no market data and are only exercised via the
  // "Force Test Swap" playground button (server-side /api/force-swap).
];

// Unichain Sepolia mock tokens — selectable as the playground pair under the
// Unichain Sepolia (1301) picker tab. Presentation registry only: the real
// addresses/decimals live in the server catalog (mirrored with the Rust
// engine), which is what the swap encoder consumes.
const MOCK_REGISTRY = [
  { symbol: 'mUSDT', name: 'Mock Tether (Unichain Sepolia)' },
  { symbol: 'mUSDC', name: 'Mock USD Coin (Unichain Sepolia)' },
] as const;

// Chains a token exists on, for the pair picker network tabs: registry tokens
// are mainnet-addressed (1), the mocks live on Unichain Sepolia (1301).
const tokenChainsOf = (symbol: string): number[] => {
  const known = knownChainOf(symbol);
  return known ? [known] : [];
};

const tokenBySymbol = (symbol: string) =>
  TOKEN_REGISTRY.find((t) => t.symbol === symbol) ??
  MOCK_REGISTRY.find((t) => t.symbol === symbol);

// Chain a token is KNOWN to live on, for the network badge overlay + filter.
// Registry tokens carry mainnet addresses (chain 1); mUSDC/mUSDT are the
// Unichain Sepolia mock tokens (1301). Dynamic top-100 entries have no
// per-chain data — returning undefined keeps the UI honest (no badge / no
// false "Ethereum" attribution) instead of guessing mainnet for everything.
function knownChainOf(symbol: string): number | undefined {
  if (symbol === 'mUSDC' || symbol === 'mUSDT') return 1301;
  if (tokenBySymbol(symbol)) return 1;
  return undefined;
}

// Best-effort execution chain for a pair: the persisted picker tab when it
// still supports BOTH sides, else the pair's default chain. The stored tab is
// what the user actually picked (pickNetworkForPair alone ignores their tab
// choice and would flip a Base-picked UNI/USDC back to Polygon).
function storedOrDefaultChainKeyForPair(base: string, quote: string): string | undefined {
  try {
    const stored = parseInt(localStorage.getItem('trust_ai_pair_chain') ?? '', 10);
    if (!Number.isNaN(stored) && tokenSupportedOnChain(base, stored) && tokenSupportedOnChain(quote, stored)) {
      return networkKeyForChainId(stored);
    }
  } catch { /* private mode */ }
  return pickNetworkForPair(base, quote);
}

// Presentation-only avatar: official token logo with a colored letter
// fallback. Purely cosmetic — symbols/addresses (the identifiers shared with
// the Rust engine and the server) are never derived from this component.
function TokenAvatar({ symbol, size, color }: { symbol: string; size: number; color?: string }) {
  const logo = TOKEN_LOGOS[symbol];
  return (
    <span className="token-avatar" style={{ background: color ?? '#3a4354', width: size, height: size, fontSize: size * 0.4, position: 'relative', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{symbol.slice(0, 1)}</span>
      {logo ? (
        <img
          src={logo}
          alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }}
        />
      ) : null}
    </span>
  );
}

// Known EVM chains for the wallet dot (color) + tooltip label. Keyed by hex
// chain id returned from eth_chainId. Add networks here as they are supported.
const CHAIN_META: Record<string, { name: string; color: string }> = {
  '0x1': { name: 'Ethereum Mainnet', color: '#38ef7d' },
  '0xaa36a7': { name: 'Sepolia Testnet', color: '#9d4edd' },
  '0x515': { name: 'Unichain Sepolia', color: '#ff3366' },
  '0x82': { name: 'Unichain Mainnet', color: '#ff3366' },
};

const chainMetaOf = (id: string | null) =>
  (id && CHAIN_META[id.toLowerCase()]) || { name: 'Unknown network', color: '#5c6b7e' };

// Provider metadata for the Credentials popover: which need a key + the input
// placeholder hint. Keyless providers marked `keylessProbe: true` still get a
// Test button (a connectivity check — no key involved). Keys are only
// stored/used for providers that require one.
const PROVIDER_META: Record<string, { name: string; needsKey: boolean; placeholder: string; keylessProbe?: boolean }> = {
  mock: { name: 'Mock AI', needsKey: false, placeholder: '' },
  mock_pair: { name: 'Mock Pair', needsKey: false, placeholder: '' },
  deepseek: { name: 'DeepSeek', needsKey: true, placeholder: 'sk-...' },
  openai: { name: 'OpenAI', needsKey: true, placeholder: 'sk-...' },
  anthropic: { name: 'Claude', needsKey: true, placeholder: 'sk-ant-...' },
  gemini: { name: 'Gemini', needsKey: true, placeholder: 'AIza…' },
  ollama_cloud: { name: 'Ollama Cloud', needsKey: true, placeholder: 'Ollama API key (ollama.com/settings/keys)' },
  ollama: { name: 'Ollama', needsKey: false, placeholder: '', keylessProbe: true }
};




// Formats prices across a wide range: WBTC/USDC (~$68k), WETH/LINK (~$18) and
// sub-dollar pairs such as UNI/WETH (~0.0022) all display usefully.
const fmtPrice = (v: number) =>
  v >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(4);

// Formats a real 24h % change (CoinGecko): signed + colored. Returns null text
// for unknown tokens (e.g. testnet mocks) instead of an invented number.
const fmtChange = (change: number | null | undefined): { text: string; color: string } =>
  typeof change === 'number'
    ? { text: `${change >= 0 ? '▲' : '▼'} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, color: change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }
    : { text: '— 24h', color: 'var(--text-dim)' };

// Formats a relative time ago string (e.g. "12s ago", "1m ago").
const fmtTimeAgo = (date: Date) => {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
};

// Masks a provider endpoint URL for display (keeps host + tail of the key path)
// so the stored RPC link can be shown in the modal without leaking the key.
const maskRpcUrl = (url: string) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const masked = last.length > 6 ? `${last.slice(0, 3)}...${last.slice(-3)}` : '••••';
    return `${u.protocol}//${u.host}/.../${masked}`;
  } catch {
    return url.length > 20 ? `${url.slice(0, 12)}...${url.slice(-6)}` : url;
  }
};

function AppContent() {
  const [connected, setConnected] = useState(false);
  const [currentProvider, setCurrentProvider] = useState<string>('mock');
  const [emergencyPause, setEmergencyPause] = useState(false);
  const [maxSlippageBps, setMaxSlippageBps] = useState<number>(50);
  // Pair persistence + echo guards. Seeded from localStorage so a page
  // reload / StrictMode remount keeps the user's last pair instead of
  // re-seeding the default (which the push effect would then re-push,
  // reverting the server to a value the user had already changed).
  const [selectedPair, setSelectedPair] = useState<string>(() => {
    try { return localStorage.getItem(PAIR_STORAGE_KEY) || 'WBTC/USDC'; } catch { return 'WBTC/USDC'; }
  });
  // Mirror of the last pair value this UI actually observed (WS guards read
  // state can't see fresh values inside the same closure). Seeded from the
  // same persisted value.
  const selectedPairRef = useRef<string>(selectedPair);
  // Pair already pushed to the server (load-push effect guard).
  const pushedPairRef = useRef<string | null>(selectedPair);
  // Stable membership map for the curated quote-side cap (which dynamic
  // tokens make the ~10-token counterpart list). Filled once in universe
  // order and reused across renders/re-filters so the list never flickers.
  const quoteDynamicSeen = useRef<Map<string, boolean>>(new Map());
  // Per-instance echo guard: with TWO dashboards open (desktop WebView +
  // browser tab), a per-value-only guard lets dashboard A apply dashboard B's
  // echo as a "different" pair and re-push it — the WBTC/USDC↔WETH/USDC
  // ping-pong. Instance keying makes every client ignore echoes that were not
  // triggered by it; a client only writes its OWN pair after a user action.
  const clientInstanceId = useRef<string>(
    (() => { try { return localStorage.getItem(PAIR_INSTANCE_KEY) || ''; } catch { return ''; } })() ||
    (() => { const id = Math.random().toString(36).slice(2); try { localStorage.setItem(PAIR_INSTANCE_KEY, id); } catch { /* private mode */ } return id; })()
  );
  useEffect(() => {
    selectedPairRef.current = selectedPair;
    try { localStorage.setItem(PAIR_STORAGE_KEY, selectedPair); } catch { /* private mode */ }
  }, [selectedPair]);
  const [analysisIntervalSec, setAnalysisIntervalSec] = useState<number>(15);
  const [settingsTab, setSettingsTab] = useState<'risk' | 'v4' | 'network'>('risk');

  // Per-signal trade budget: the user-set cap the agent may propose per trade,
  // denominated in the BASE token of the monitored pair (WETH for WETH/USDC,
  // WBTC for WBTC/USDC, USDC for USDC/WETH). One cap per token symbol, kept in
  // localStorage and mirrored to the server so decisions get clamped. Legacy
  // single "ETH" value migrates to a WETH entry; ERC20 balance checks need
  // chain-aware addresses (Phase 4).
  const [budgetsByToken, setBudgetsByToken] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('trust_ai_budgets');
      if (raw) {
        const parsed = JSON.parse(raw);
        const clean: Record<string, number> = {};
        for (const [sym, val] of Object.entries(parsed)) {
          const n = Number(val);
          if (Number.isFinite(n) && n > 0) clean[sym] = n;
        }
        if (Object.keys(clean).length > 0) return clean;
      }
      // Legacy single-value key was ETH-denominated - migrate to a WETH entry.
      const legacy = Number(localStorage.getItem('trust_ai_max_trade_amount') || '');
      if (Number.isFinite(legacy) && legacy > 0) {
        localStorage.removeItem('trust_ai_max_trade_amount');
        return { WETH: legacy };
      }
    } catch {
      /* ignore malformed storage */
    }
    return {};
  });
  const [maxTradeAmountEth, setMaxTradeAmountEth] = useState<number>(0.25);
  const [budgetDraft, setBudgetDraft] = useState<string>('0.25');
  const [budgetError, setBudgetError] = useState<string | null>(null);

  // When the user dismisses a signal (Cancel), the swap card is hidden until
  // the next decision arrives. Undo is available in the dismissed notice.
  const [dismissedEventId, setDismissedEventId] = useState<string | null>(null);

  // DEX-style custom pair builder (base / quote token pickers)
  const [pairBase, setPairBase] = useState<string>('WETH');
  const [pairQuote, setPairQuote] = useState<string>('USDC');
  // Server network key of the pair's EXECUTION chain (null = derived from the
  // pair via pickNetworkForPair). Set when the user picks a pair under a
  // network tab in the unified picker; pushed to the server via /api/settings
  // so the swap route follows the pair, not a header dropdown.
  const [pairChainKey, setPairChainKey] = useState<string | null>(null);
  const [isTokenPickerOpen, setIsTokenPickerOpen] = useState<false | 'base' | 'quote'>(false);
  const [tokenSearch, setTokenSearch] = useState<string>('');
  const [selectedNetworkFilter, setSelectedNetworkFilter] = useState<number | 'ALL'>(() => {
    try {
      const stored = localStorage.getItem('trust_ai_pair_chain');
      const parsed = stored ? parseInt(stored, 10) : NaN;
      // Only restore filters that still exist as picker tabs (legacy values
      // like Sepolia 11155111 are no longer offered — fall back to 'ALL').
      if (!Number.isNaN(parsed) && PICKER_NETWORKS.some((n) => n.chainId === parsed)) return parsed;
      return 'ALL';
    } catch {
      return 'ALL';
    }
  });
  
  // Network dropdown inside the pair picker (minimal icon selector).
  const [netDropdownOpen, setNetDropdownOpen] = useState(false);

  // Web3 Wallet State - wagmi + AppKit share ONE store (Reown WagmiAdapter), so
  // the header always mirrors the real wallet session (extension OR WalletConnect).
  const { address: account, isConnected, chainId: wagmiChainId } = useActiveAccount();
  const { data: ensName } = useActiveEnsName();
  const { connectAsync, connectors } = useWalletConnect();
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  // Convert Wagmi's numeric chain id to the hex string that chainMetaOf expects.
  const wagmiChainIdNum = wagmiChainId;
  const chainId = wagmiChainIdNum ? `0x${wagmiChainIdNum.toString(16)}` : null;
  const { disconnect } = useWalletDisconnect();
  // Async chain switch — used by the swap executor to move the wallet to the
  // route's target network before signing (wallet-side prompt, no manual
  // header switching needed).
  const { switchChainAsync } = useSwitchChainHook();
  // Balance is read from the active provider and refreshed whenever the
  // account changes (or the user switches accounts in their wallet).
  const [balance, setBalance] = useState<string | null>(null);

  // Header network dropdown REMOVED — network selection lives in the unified
  // pair picker (Rede + Par in one place).
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);

  // Close the AI provider dropdown when clicking outside.
  useEffect(() => {
    if (!aiDropdownOpen) return;
    const modal = document.getElementById('ai-dropdown-menu');
    if (!modal) return;
    const handler = (e: MouseEvent) => {
      if (!modal.contains(e.target as Node)) {
        setAiDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [aiDropdownOpen]);

  // Live on-chain data (refreshed every ~12s when a wallet is connected)
  const [liveBlockNumber, setLiveBlockNumber] = useState<number>(0);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [liveUsdPrices, setLiveUsdPrices] = useState<Record<string, number>>({});
  const [liveTokenBalances, setLiveTokenBalances] = useState<Record<string, number>>({});
  const [lastPriceUpdate, setLastPriceUpdate] = useState<Date | null>(null);

  // Keep the displayed balance in sync with the connected account. Reading
  // directly from the active provider avoids stale React state if the user
  // switches accounts in their wallet after connecting.
  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setBalance(null);
      return;
    }
    const refresh = async () => {
      const provider = await getActiveProvider();
      if (!provider || cancelled) return;
      try {
        const rawBal = await provider.request({
          method: 'eth_getBalance',
          params: [account, 'latest']
        });
        if (!cancelled) {
          setBalance((parseInt(rawBal as string, 16) / 1e18).toFixed(4));
        }
      } catch {
        // Balance unavailable (locked wallet, wrong chain, etc.) - leave the
        // current value as-is rather than clearing it.
      }
    };
    refresh();
    return () => { cancelled = true; };
  }, [account]);

  // Auto-refresh live data every ~12 seconds when a wallet is connected, plus
  // USD prices from CoinGecko every 60s regardless of wallet state (CoinGecko is
  // an external REST API — no wallet needed).
  useEffect(() => {
    let cancelled = false;
    let usdInterval: ReturnType<typeof setInterval> | null = null;
    let onChainInterval: ReturnType<typeof setInterval> | null = null;

    //  USD prices from CoinGecko (always, no wallet needed)
    const fetchUsdPrices = async () => {
      if (cancelled) return;
      try {
        // UNIFIED price source: one batched map covering the registry tokens
        // PLUS the dynamic top-100 (the same rows the pair picker shows). The
        // monitor card therefore displays exactly the number seen while
        // selecting the pair — no selector-vs-monitor divergence.
        const symbols = Array.from(new Set([
          ...Object.keys(TOKENS),
          ...topTokensRef.current.map((t) => t.symbol),
        ]));
        const usdMap = await getUsdPriceMap(symbols);
        if (!cancelled && Object.keys(usdMap).length > 0) {
          setLiveUsdPrices(usdMap);
          setLastPriceUpdate(new Date());
        }
      } catch (err) {
        console.warn('USD price fetch error:', err);
      }
    };

    fetchUsdPrices();
    usdInterval = setInterval(fetchUsdPrices, 60000);

    // Top-token universe for the picker (rate-limit friendly: every 10 min).
    const fetchTokens = async () => {
      if (cancelled) return;
      const tokens = await fetchTopTokens(100);
      if (!cancelled && tokens.length > 0) setTopTokens(tokens);
    };
    fetchTokens();
    const tokensInterval = setInterval(fetchTokens, 600000);

    //  On-chain data (only when wallet connected + chain known) 
    if (account && wagmiChainIdNum) {
      const fetchLiveData = async () => {
        if (cancelled) return;

        try {
          // Block number first — when the RPC circuit breaker is open or the
          // endpoint is down it returns 0 and the whole cycle is skipped
          // (no pointless balance calls against a dead endpoint).
          const block = await getBlockNumber(wagmiChainIdNum);
          if (!cancelled && block > 0) setLiveBlockNumber(block);
          if (!block) return;

          // Token price pair (on-chain or simulated).
          const pair = selectedPair !== 'ALL' && selectedPair.includes('/')
            ? selectedPair.split('/')
            : ['WETH', 'USDC'];
          const baseSym = pair[0];
          const quoteSym = pair[1];

          const price = await getTokenPrice(baseSym, quoteSym, wagmiChainIdNum);
          if (!cancelled && price > 0) {
            setLivePrices({ [`${baseSym}/${quoteSym}`]: price });
          }

          // Token balances — ONLY tokens whose catalog chain matches the
          // wallet chain. Registry tokens are mainnet-addressed and m-tokens
          // live on Unichain Sepolia; reading them against Arbitrum/Base
          // guarantees contract-not-found errors on every cycle (the 3k-error
          // console storm). On other chains only the native balance shows.
          if (!cancelled) {
            const balanceSymbols = Object.keys(TOKENS).filter((sym) => {
              if (sym === 'mUSDC' || sym === 'mUSDT') return wagmiChainIdNum === 1301;
              return wagmiChainIdNum === 1;
            });
            if (balanceSymbols.length === 0) {
              const nativeBal = await getNativeBalance(account, wagmiChainIdNum);
              if (!cancelled) setLiveTokenBalances({ ETH: nativeBal });
            } else {
              const balPromise = Promise.all(
                balanceSymbols.map((sym) =>
                  getTokenBalance(sym, account, wagmiChainIdNum).then((b) => ({ sym, b }))
                )
              );
              const [nativeBal, tokenBalsResult] = await Promise.all([
                getNativeBalance(account, wagmiChainIdNum),
                balPromise,
              ]);
              if (!cancelled) {
                const balMap: Record<string, number> = { ETH: nativeBal };
                for (const { sym, b } of tokenBalsResult) {
                  if (b > 0) balMap[sym] = b;
                }
                setLiveTokenBalances(balMap);
              }
            }
          }
        } catch (err) {
          console.warn('Live data fetch error:', err);
        }
      };

      fetchLiveData();
      // 30s cadence — balance/block data is decorative; 12s × (2 reads × 11
      // tokens) against free public RPCs trips their rate limits for everyone.
      onChainInterval = setInterval(fetchLiveData, 30000);
    }

    return () => {
      cancelled = true;
      if (usdInterval) clearInterval(usdInterval);
      if (onChainInterval) clearInterval(onChainInterval);
      clearInterval(tokensInterval);
    };
  }, [account, wagmiChainIdNum, selectedPair]);
  // Set once the engine's first trigger/decision arrives over WS (the engine
  // only speaks by streaming triggers, so first decision == engine alive).
  const [engineAlive, setEngineAlive] = useState(false);
  const [activeTxHash, setActiveTxHash] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  // Execution sub-step shown while txStatus === 'pending' (approve vs swap).
  const [txStep, setTxStep] = useState<'approve' | 'swap' | null>(null);
  // Phase 4 — source label of the monitor price reported by the orchestrator
  // for the current signal (pool = live v4 slot0, coingecko = market ratio,
  // synthetic = engine placeholder). Updated with every NEW_DECISION.
  const [priceSource, setPriceSource] = useState<'pool' | 'coingecko' | 'synthetic'>('synthetic');
  // Signal lock: while a wallet transaction is in flight (signature popup open
  // or tx awaiting confirmation) the swap card must NOT be replaced by the next
  // engine decision — a mid-signature card swap invites double-signing the old
  // signal or signing a signal the user never saw. Implemented as a ref (set
  // synchronously at click time, cleared in the execution handler's finally)
  // plus a state flag for rendering. NEW_DECISION handlers consult the ref and
  // hold the previous card instead of overwriting it.
  const swapInFlightRef = useRef(false);
  const [isSwapInFlight, setIsSwapInFlight] = useState(false);
  // How many engine decisions were suppressed while the lock was active —
  // surfaced on the card after release so the user knows newer signals existed.
  const [skippedSignalCount, setSkippedSignalCount] = useState(0);
  const [isRiskOpen, setIsRiskOpen] = useState(true);

  // Uniswap v4 route config (the only route since the v3 removal). Pushed to
  // the server via /api/settings; the server's calldata encoder reads it. The
  // hook address is validated client-side against the v4 PoolManager
  // (getHookPermissions) before being saved.
  const [v4Fee, setV4Fee] = useState<number>(2500); // user's deployed v4 pool: 0.25%
  const [v4TickSpacing, setV4TickSpacing] = useState<number>(60);
  const [v4HooksAddress, setV4HooksAddress] = useState<string>('');
  const [v4HookPermissions, setV4HookPermissions] = useState<string>('');
  const [hookStatus, setHookStatus] = useState<string | null>(null);

  // Zero-Storage API Keys (stored only in the browser's localStorage)
  const [apiKeys, setApiKeys] = useState<{ [provider: string]: string }>(() => {
    try {
      return JSON.parse(localStorage.getItem('trust_ai_api_keys') || '{}');
    } catch {
      return {};
    }
  });
  const [isModalOpen, setIsModalOpen] = useState(false);
  // RPC plug-in section inside the Credentials popover (collapsed by default).
  const [isRpcOpen, setIsRpcOpen] = useState(false);

  // Reflect the persisted/negotiated budget inside the input field whenever it
  // changes (local save, server SYSTEM_INIT/SETTINGS_UPDATED, etc.).
  useEffect(() => {
    setBudgetDraft(String(maxTradeAmountEth));
  }, [maxTradeAmountEth]);

  // Budget denomination follows the active pair: the base symbol of the pair
  // being monitored ("ALL" monitor mode falls back to WETH, the base of the
  // default pairs). Switching pairs swaps the unit AND loads that token's own
  // saved cap - each token keeps its own per-signal budget.
  const budgetSymbol = selectedPair === 'ALL' ? 'WETH' : pairBase;
  useEffect(() => {
    setMaxTradeAmountEth(budgetsByToken[budgetSymbol] ?? 0.25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetSymbol, budgetsByToken]);
  
  const [latestEvent, setLatestEvent] = useState<EventLog | null>(null);

  // ── Signal/pair coherence ────────────────────────────────────────────────
  // The engine streams the pair it last resolved; right after the user picks
  // a new pair there is a window where NEW_DECISION payloads still carry the
  // OLD pair. A stale-pair signal must NEVER drive the AI Signal card (it
  // used to leave the mUSDT/mUSDC playground route rendered under LINK/USDC
  // icons). Mock tokens are special-cased: the playground pair is only
  // coherent when explicitly selected — a synthetic BUY leaking under any
  // other pair header is exactly the confusion this guard kills.
  const MOCK_PAIR_SYMBOLS = new Set(['MUSDC', 'MUSDT']);
  const signalPairMatchesSelection = (signalPair: string, selected: string): boolean => {
    if (!signalPair) return true;
    const norm = (s: string) => s.trim().toUpperCase();
    const [sigBase, sigQuote] = norm(signalPair).split('/');
    const [selBase, selQuote] = norm(selected).split('/');
    const sigIsMock = !!sigBase && !!sigQuote && MOCK_PAIR_SYMBOLS.has(sigBase) && MOCK_PAIR_SYMBOLS.has(sigQuote);
    if (sigIsMock) return selBase === sigBase && selQuote === sigQuote;
    if (selected === 'ALL') return true;
    if (!sigBase || !sigQuote || !selBase || !selQuote) return norm(signalPair) === norm(selected);
    return sigBase === selBase && sigQuote === selQuote;
  };
  // Whether the displayed signal belongs to the pair currently on screen
  // ('ALL' shows every real pair; the mock pair only when it is selected).
  const signalIsCurrent = !latestEvent || signalPairMatchesSelection(latestEvent.trigger.pair, selectedPair);
  const [logs, setLogs] = useState<EventLog[]>([]);

  // Dynamic token universe for the picker: top ~100 tokens by market cap
  // (CoinGecko /coins/markets — one call, refreshed every 10 min).
  const [topTokens, setTopTokens] = useState<TopToken[]>([]);
  // Ref mirror for callbacks that must read the LATEST top-token list without
  // re-subscribing the 60s price loop (unified monitor/picker price source).
  const topTokensRef = useRef<TopToken[]>([]);
  useEffect(() => { topTokensRef.current = topTokens; }, [topTokens]);

  // Picker list: tradable registry tokens (with real addresses + colors) first,
  // then the top-market-cap tokens. Registry wins on symbol collisions. On the
  // BASE side only tradable tokens are offered — a market-cap token with no
  // deployable address in this build cannot be the swap input; on the QUOTE
  // side the full universe is available (view-only pairs are fine for watching
  // prices, but only registry-backed pairs can execute swaps).
  const pickerTokens = useMemo<TopToken[]>(() => {
    const universe = new Map<string, TopToken>();
    for (const t of TOKEN_REGISTRY) {
      universe.set(t.symbol, { symbol: t.symbol, name: t.name, usd: liveUsdPrices[t.symbol] ?? 0, change24h: getUsdChange24h(t.symbol), logoURI: TOKEN_LOGOS[t.symbol] });
    }
    // Unichain Sepolia tab: the mock playground tokens (mUSDC/mUSDT) are
    // selectable again as a REAL pair for the user-deployed test pool — the
    // server's mock detection handles routing them to the Unichain Sepolia
    // v4 route.
    for (const m of MOCK_REGISTRY) {
      if (!universe.has(m.symbol)) {
        universe.set(m.symbol, { symbol: m.symbol, name: m.name, usd: 0, change24h: null, logoURI: undefined });
      }
    }
    for (const t of topTokens) {
      if (!universe.has(t.symbol)) universe.set(t.symbol, t);
    }
    return Array.from(universe.values());
  }, [topTokens, liveUsdPrices]);

  // API-keys modal helpers
  const [showKeyValues, setShowKeyValues] = useState(false);
  const [keysNotice, setKeysNotice] = useState<string | null>(null);

  // RPC plug-in (Phase 4 readiness): provider + network + key are composed
  // into a full endpoint URL, persisted locally and pushed to the orchestrator
  // (/api/settings - engine pulls it from /api/rpc-config on restart).
  const [rpcProvider, setRpcProvider] = useState<string>('alchemy');
  const [rpcNetwork, setRpcNetwork] = useState<string>(() => {
    try {
      return localStorage.getItem('trust_ai_rpc_network') || 'sepolia';
    } catch {
      return 'sepolia';
    }
  });
  const [rpcKey, setRpcKey] = useState<string>('');
  const [rpcCustomUrl, setRpcCustomUrl] = useState<string>('');
  const [rpcSaved, setRpcSaved] = useState<{ provider: string; network: string; maskedUrl: string } | null>(() => {
    try {
      const raw = localStorage.getItem('trust_ai_rpc');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.url) {
          return { provider: o.provider || 'custom', network: o.network || 'sepolia', maskedUrl: maskRpcUrl(o.url) };
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    return null;
  });
  const [rpcError, setRpcError] = useState<string | null>(null);
  // Plug-and-play validation feedback (Configuration modal). 'testing' shows a
  // spinner, 'ok' a green check, 'warn' amber (saved without validation),
  // 'fail' a red message — set from the real probes answered by
  // POST /api/validate (server side, keys never logged).
  type ValidateState = 'idle' | 'testing' | 'ok' | 'warn' | 'fail';
  const [rpcTest, setRpcTest] = useState<{ state: ValidateState; message: string | null }>({ state: 'idle', message: null });
  const [llmTest, setLlmTest] = useState<{ state: ValidateState; message: string | null }>({ state: 'idle', message: null });
  const [blockCount, setBlockCount] = useState<number>(0);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Web3 Wallet Connect Handler (EIP-1193 / MetaMask / Rabby / WalletConnect)
  //
  // 1) Injected browser extension (MetaMask/Rabby/Coinbase Wallet): connects
  //    through wagmi's injected connector so the SHARED wagmi/AppKit store is
  //    updated - this is what makes the header pill + network selector react.
  // 2) Otherwise opens the AppKit modal (WalletConnect QR / mobile deep link,
  //    also used in the desktop .exe where no browser extension exists). The
  //    Reown WagmiAdapter routes that connection into the same wagmi store.
  //
  // Returns the connected account address (or null if the connection failed).
  const handleConnectWallet = async (): Promise<string | null> => {
    // 1) Injected browser extension - wagmi injected connector (shared store).
    const injectedConnector = connectors.find(
      (c) => c.type === 'injected' || c.id === 'injected' || /injected|metamask|rabby/i.test(c.id)
    );
    if (typeof window !== 'undefined' && (window as any).ethereum && injectedConnector) {
      try {
        setIsConnectingWallet(true);
        const res = await connectAsync({ connector: injectedConnector });
        const userAcc = (res.accounts[0] ?? null) as string | null;
        if (userAcc) {
          // Re-read the balance from the live session provider so we always
          // have the latest value even right after a fresh connect.
          try {
            const provider = await getActiveProvider();
            if (provider) {
              const rawBal = await provider.request({
                method: 'eth_getBalance',
                params: [userAcc, 'latest']
              });
              setBalance((parseInt(rawBal as string, 16) / 1e18).toFixed(4));
            }
          } catch {
            // Balance refresh also happens via the useEffect below.
          }
          return userAcc;
        }
      } catch (err) {
        console.warn('Injected wallet connection failed, opening the modal instead:', err);
      } finally {
        setIsConnectingWallet(false);
      }
    }

    // 2) AppKit modal (WalletConnect QR / mobile / desktop). Connections land
    //    in the shared wagmi store through the Reown adapter, so the header
    //    syncs automatically once the session is established.
    try {
      setIsConnectingWallet(true);
      await appKit.open();
      // After the modal closes, wait briefly for the session to register so
      // callers (e.g. swap execution) can act on the fresh account.
      return await waitForWalletConnection(8000);
    } catch (err) {
      console.error('WalletConnect/AppKit modal error:', err);
      return null;
    } finally {
      setIsConnectingWallet(false);
    }
  };

  // Uniswap 1-Click Swap Execution Handler
  //
  // Reads the active provider from the connected wallet session (injected
  // browser extension preferred, WalletConnect/AppKit connector as fallback)
  // so the swap always uses a live provider — even if the user switched
  // accounts in their wallet after connecting.
  const handleExecuteUniswapSwap = async (decision: AIDecision) => {
    const swapData = decision.uniswap_swap_data;
    if (!swapData) return;

    // Per-trade budget defense-in-depth: the server already clamps decisions to
    // the user's cap, but signals that arrived before a cap change can still be
    // in the feed - never send anything above the configured budget. Amounts
    // are sized in the signal pair's BASE token for both directions, so the
    // comparison against the base-denominated cap is direct.
    if (latestEvent) {
      const chk = budgetCheckFor(decision, latestEvent.trigger);
      if (!chk.ok) {
        alert(`Signal proposes ${decision.suggested_amount_eth} ${chk.baseSym} (paying ~${fmtPrice(chk.spend)} ${chk.spendSym}), above your per-trade budget of ${chk.cap} ${chk.baseSym}. Raise the budget in Risk & Execution to execute this signal.`);
        return;
      }
    }
    if (decision.suggested_amount_eth <= 0) {
      alert('This signal carries no executable amount. Skipping execution.');
      return;
    }
    try {
      // Signal lock entry: one execution cycle at a time. The synchronous ref
      // also guards against a double-click racing React's async state update.
      // Acquired inside the try so the finally below releases it on every
      // early exit (budget rejection, chain mismatch, wallet errors, success).
      if (swapInFlightRef.current) return;
      swapInFlightRef.current = true;
      setIsSwapInFlight(true);

      setTxStatus('pending');
      setTxStep(null);

      // Chain sanity check: the swap route is network-specific. Executing on
      // the wrong chain silently produces a "0 ETH transfer" (the calldata is
      // ignored by non-contract addresses / foreign routers) - fail fast with
      // a clear message instead of a dead transaction.
      //
      // The target is compared NUMERICALLY against wallet_chain_id from the
      // server (derived from the resolved route network) — the previous
      // text-sniffing of the route_summary string produced false mismatches
      // when the RPC plug-in's network label diverged from the wallet.
      // wallet_chain_id is authoritative: the server always derives it from
      // the same resolution that encoded the calldata.
      const targetChainId = swapData.wallet_chain_id;
      if (wagmiChainIdNum !== undefined && targetChainId !== undefined && wagmiChainIdNum !== targetChainId) {
        setTxStatus('error');
        const targetName = CHAIN_NAMES[targetChainId] ?? `chain ${targetChainId}`;
        const walletName = CHAIN_NAMES[wagmiChainIdNum] ?? `chain ${wagmiChainIdNum}`;
        // Ask the wallet to switch network itself instead of demanding a manual
        // switch in the header: switchChain opens the wallet's own network
        // prompt (MetaMask/Rabby popup or a WalletConnect session update) and
        // wagmi auto-requests wallet_addEthereumChain for missing networks.
        // Execution stays locked (the signal lock is released in the finally);
        // the user re-clicks Confirm Swap once the wallet is on the target.
        try {
          await switchChainAsync({ chainId: targetChainId });
          alert(`Network switch to ${targetName} confirmed in your wallet. Click Confirm Swap again to execute.`);
        } catch (err) {
          console.warn('Automatic network switch rejected:', err);
          alert(
            `This swap route targets ${targetName}, but your wallet is on ${walletName} and the network switch was rejected. Switch to ${targetName} in the header dropdown, then retry.`
          );
        }
        return;
      }

      // Read the active account directly from the provider: right after a fresh
      // connect request the React state may not be updated yet, so relying on
      // the `account` state here can produce a tx with `from: null`.
      let userAcc: string | null = account ?? null;
      if (!userAcc) {
        userAcc = await handleConnectWallet();
        if (!userAcc) {
          setTxStatus('error');
          return;
        }
      }

      // Read the active provider from the ACTUAL wallet session the user
      // approved (injected extension OR the WalletConnect session), instead of
      // blindly using window.ethereum which has no session in the desktop app.
      const ethereum = await getActiveProvider();
      if (!ethereum) {
        alert('No Web3 wallet (MetaMask/Rabby) detected in your browser, and no WalletConnect session is active. Connect a wallet first.');
        setTxStatus('error');
        return;
      }

      // v4 route: Universal Router + Permit2 (the only execution path since
      // the v3 route was removed, 2026-09-15).
      // The server already encoded the UR `execute(commands, inputs, deadline)`
      // calldata. No recipient patch is needed: the UR's TAKE_ALL action sends
      // the output to msg.sender (the executing wallet). ERC20 inputs are
      // pulled via Permit2, so the allowance gate approves (token → Permit2)
      // with a standard ERC20 approve and (Permit2 → router) with
      // permit2.approve before executing.
      {
        const tokenIn = swapData.token_in_address as `0x${string}`;
        const amountIn = BigInt(swapData.amount_in_wei || '0');
        const permit2 = (swapData.permit2_address || '0x000000000022D473030F116dDEE9F6B43aC78BA3') as `0x${string}`;
        const router = swapData.to_address as `0x${string}`;
        const MAX_UINT256 = (1n << 256n) - 1n;
        const MAX_UINT48 = (1n << 48n) - 1n;

        if (BigInt(swapData.value_wei) === 0n && amountIn > 0n) {
          // 1) ERC20 allowance → Permit2 (permit2.transferFrom pulls from user)
          let erc20Ok = false;
          try {
            const allowanceResult = await ethereum.request({
              method: 'eth_call',
              params: [
                {
                  to: tokenIn,
                  data: encodeFunctionData({
                    abi: ERC20_MIN_ABI,
                    functionName: 'allowance',
                    args: [userAcc as `0x${string}`, permit2]
                  })
                },
                'latest'
              ]
            });
            const erc20Allowance = decodeFunctionResult({
              abi: ERC20_MIN_ABI,
              functionName: 'allowance',
              data: allowanceResult as `0x${string}`
            });
            erc20Ok = erc20Allowance >= amountIn;
          } catch (err) {
            console.warn('Could not read ERC20→Permit2 allowance — approving anyway:', err);
          }
          if (!erc20Ok) {
            setTxStep('approve');
            const approveResult = await ethereum.request({
              method: 'eth_sendTransaction',
              params: [
                {
                  from: userAcc,
                  to: tokenIn,
                  data: encodeFunctionData({
                    abi: ERC20_MIN_ABI,
                    functionName: 'approve',
                    args: [permit2, MAX_UINT256]
                  }),
                  value: '0x0'
                }
              ]
            });
            const approveHash = normalizeTxHash(approveResult);
            if (!approveHash) {
              alert('The Permit2 token approval could not be submitted. Aborting the swap.');
              setTxStatus('error');
              setTxStep(null);
              return;
            }
            setActiveTxHash(approveHash);
            const approved = await waitForTransaction(ethereum, approveHash, 60000);
            if (!approved) {
              alert(`Permit2 token approval (${approveHash.slice(0, 10)}...) was not confirmed on-chain. Aborting the swap — retry once it confirms.`);
              setTxStatus('error');
              setTxStep(null);
              return;
            }
          }

          // 2) Permit2 allowance user → router for the input token
          let p2Amount = 0n;
          try {
            const p2Result = await ethereum.request({
              method: 'eth_call',
              params: [
                {
                  to: permit2,
                  data: encodeFunctionData({
                    abi: PERMIT2_ABI,
                    functionName: 'allowance',
                    args: [userAcc as `0x${string}`, tokenIn, router]
                  })
                },
                'latest'
              ]
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const p2: any = decodeFunctionResult({
              abi: PERMIT2_ABI,
              functionName: 'allowance',
              data: p2Result as `0x${string}`
            });
            p2Amount = BigInt(p2[0] ?? 0);
          } catch (err) {
            console.warn('Could not read Permit2 allowance — approving anyway:', err);
          }
          if (p2Amount < amountIn) {
            setTxStep('approve');
            const p2ApproveResult = await ethereum.request({
              method: 'eth_sendTransaction',
              params: [
                {
                  from: userAcc,
                  to: permit2,
                  data: encodeFunctionData({
                    abi: PERMIT2_ABI,
                    functionName: 'approve',
                    // expiration is uint48 → fits in a JS number (2^48-1 ≈ 2.8e14)
                    args: [tokenIn, router, amountIn, Number(MAX_UINT48)]
                  }),
                  value: '0x0'
                }
              ]
            });
            const p2ApproveHash = normalizeTxHash(p2ApproveResult);
            if (!p2ApproveHash) {
              alert('The Permit2 router approval could not be submitted. Aborting the swap.');
              setTxStatus('error');
              setTxStep(null);
              return;
            }
            setActiveTxHash(p2ApproveHash);
            const p2Approved = await waitForTransaction(ethereum, p2ApproveHash, 60000);
            if (!p2Approved) {
              alert(`Permit2 router approval (${p2ApproveHash.slice(0, 10)}...) was not confirmed on-chain. Aborting the swap.`);
              setTxStatus('error');
              setTxStep(null);
              return;
            }
          }
        }

        setTxStep('swap');
        const v4TxParams = {
          from: userAcc,
          to: router,
          data: swapData.calldata,
          value: '0x' + BigInt(swapData.value_wei).toString(16)
        };
        const v4TxHashResult = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [v4TxParams]
        });
        const v4NormalizedHash = normalizeTxHash(v4TxHashResult);
        if (v4NormalizedHash) {
          setActiveTxHash(v4NormalizedHash);
        }
        setTxStep(null);
        setTxStatus('success');
        return;
      }
    } catch (err: any) {
      console.error('Uniswap Swap Execution Error:', err);
      setTxStatus('error');
      setTxStep(null);
    } finally {
      // Release the signal lock on every exit path: user rejection in the
      // wallet, revert, chain-mismatch abort, missing approvals, success —
      // the card is free to accept the next engine decision again.
      swapInFlightRef.current = false;
      setIsSwapInFlight(false);
    }
  };

  // WebSocket Connection to TS Server Gateway (Port 3001)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;
    // disposed guards the reconnect loop: the cleanup closes the socket,
    // which fires onclose ASYNCHRONOUSLY AFTER the effect is gone — without
    // this flag that late onclose schedules a GHOST reconnect on the dead
    // closure. Ghost sockets reconnect forever, each receives SYSTEM_INIT
    // carrying the server's OLD pair and silently revert the user's just-
    // picked pair (the "state keeps restoring itself" bug).
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket('ws://localhost:3001');

      ws.onopen = () => {
        setConnected(true);
        console.log('Connected to TRusT-AI Gateway WebSocket');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'SYSTEM_INIT') {
            setCurrentProvider(data.data.provider);
            setEmergencyPause(data.data.emergencyPause);
            if (data.data.maxSlippageBps) setMaxSlippageBps(data.data.maxSlippageBps);
            // Budget is client-owned per token symbol (budgetsByToken): the
            // server echo is intentionally ignored so restarts can't clobber it.
            // PAIR GUARD (two layers): only when the server flags a REAL change
            // (pairChanged from THIS request's mutation — single-writer), AND
            // when this instance didn't originate it (two dashboards — desktop
            // WebView + browser tab — would otherwise ping-pong each other).
            if (data.data.selectedPair && data.data.pairChanged === true && data.data.changedBy !== clientInstanceId.current) {
              selectedPairRef.current = data.data.selectedPair;
              setSelectedPair(data.data.selectedPair);
            }
            if (data.data.analysisIntervalSec) setAnalysisIntervalSec(data.data.analysisIntervalSec);
            // v4 route state (PoolKey/hook fields — v4 is the only route).
            if (typeof data.data.v4Fee === 'number' && data.data.v4Fee > 0) setV4Fee(data.data.v4Fee);
            if (typeof data.data.v4TickSpacing === 'number' && data.data.v4TickSpacing > 0) setV4TickSpacing(data.data.v4TickSpacing);
            if (typeof data.data.v4HooksAddress === 'string') setV4HooksAddress(data.data.v4HooksAddress);
            if (typeof data.data.v4HookPermissions === 'string') setV4HookPermissions(data.data.v4HookPermissions);
          } else if (data.type === 'NEW_DECISION') {
            const newLog: EventLog = {
              id: Math.random().toString(36).substring(2, 9),
              trigger: data.payload.trigger,
              decision: data.payload.decision,
              receivedAt: new Date().toLocaleTimeString()
            };
            // The feed always records the decision...
            setLogs((prev) => [newLog, ...prev.slice(0, 49)]);
            setBlockCount((c) => c + 1);
            setEngineAlive(true);
            // ...but the swap card freezes while a wallet transaction is in
            // flight: replacing the signal mid-signature could get the old tx
            // signed twice or a signal executed that the user never approved.
            // Suppressed decisions are counted and surfaced after release.
            if (swapInFlightRef.current) {
              setSkippedSignalCount((c) => c + 1);
            } else if (signalPairMatchesSelection(newLog.trigger.pair, selectedPairRef.current)) {
              // Fresh signal for the SELECTED pair: unhide the swap card and
              // drop any stale tx banner (it belonged to the previous
              // signal's card).
              setDismissedEventId(null);
              setTxStatus('idle');
              setTxStep(null);
              setActiveTxHash(null);
              setLatestEvent(newLog);
            } else {
              // Signal for a pair other than the one selected (the engine
              // stream still resolves the previous monitored_pair): feed-only.
              // Setting it as latestEvent used to leave the PREVIOUS pair's
              // route/decision rendered under the new pair's icons.
              setSkippedSignalCount((c) => c + 1);
            }
            // Phase 4 — the server stamps the decision with the live price
            // source (pool / coingecko / synthetic); surface it on the monitor.
            if (data.payload?.decision?.price_source === 'pool' || data.payload?.decision?.price_source === 'coingecko' || data.payload?.decision?.price_source === 'synthetic') {
              setPriceSource(data.payload.decision.price_source);
            }
          } else if (data.type === 'SETTINGS_UPDATED') {
            setCurrentProvider(data.payload.provider);
            setEmergencyPause(data.payload.emergencyPause);
            setMaxSlippageBps(data.payload.maxSlippageBps);
            // See SYSTEM_INIT — per-token budgets live client-side. Pair echo
            // applies ONLY on a server-flagged real change not originated by
            // this instance (two-layer ping-pong guard).
            if (data.payload.selectedPair && data.payload.pairChanged === true && data.payload.changedBy !== clientInstanceId.current) {
              selectedPairRef.current = data.payload.selectedPair;
              setSelectedPair(data.payload.selectedPair);
            }
            if (data.payload.analysisIntervalSec) setAnalysisIntervalSec(data.payload.analysisIntervalSec);
            if (typeof data.payload.v4Fee === 'number' && data.payload.v4Fee > 0) setV4Fee(data.payload.v4Fee);
            if (typeof data.payload.v4TickSpacing === 'number' && data.payload.v4TickSpacing > 0) setV4TickSpacing(data.payload.v4TickSpacing);
            if (typeof data.payload.v4HooksAddress === 'string') setV4HooksAddress(data.payload.v4HooksAddress);
            if (typeof data.payload.v4HookPermissions === 'string') setV4HookPermissions(data.payload.v4HookPermissions);
          }
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('WS Error:', err);
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, []);

  const handleUpdateSettings = async (
    newProvider?: string,
    pauseState?: boolean,
    slippage?: number,
    keysOverride?: { [provider: string]: string },
    pair?: string,
    interval?: number,
    tradeAmount?: number,
    rpc?: { rpcUrl?: string; rpcProvider?: string; rpcNetwork?: string },
    route?: { v4Fee?: number; v4TickSpacing?: number; v4HooksAddress?: string; v4HookPermissions?: string }
  ) => {
    try {
      const targetProvider = newProvider !== undefined ? newProvider : currentProvider;
      const targetKeys = keysOverride !== undefined ? keysOverride : apiKeys;
      const activeKey = targetKeys[targetProvider] || '';

      const payload: any = {
        provider: targetProvider,
        apiKey: activeKey,
        pause: pauseState !== undefined ? pauseState : emergencyPause,
        maxSlippage: slippage !== undefined ? slippage : maxSlippageBps
      };
      if (pair !== undefined) {
        payload.pair = pair;
        // Echo origin tag: lets OTHER dashboard instances ignore this push's
        // broadcast while THIS instance recognizes (and skips) its own echo.
        payload.changedBy = clientInstanceId.current;
      }
      if (interval !== undefined) payload.analysisInterval = interval;
      if (tradeAmount !== undefined) payload.maxTradeAmount = tradeAmount;
      if (rpc !== undefined) {
        payload.rpcUrl = rpc.rpcUrl;
        payload.rpcProvider = rpc.rpcProvider;
        payload.rpcNetwork = rpc.rpcNetwork;
      }
      if (route !== undefined) {
        if (route.v4Fee !== undefined) payload.v4Fee = route.v4Fee;
        if (route.v4TickSpacing !== undefined) payload.v4TickSpacing = route.v4TickSpacing;
        if (route.v4HooksAddress !== undefined) payload.v4HooksAddress = route.v4HooksAddress;
        if (route.v4HookPermissions !== undefined) payload.v4HookPermissions = route.v4HookPermissions;
      }

      await fetch('http://localhost:3001/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error('Error updating settings:', e);
    }
  };

  // Validates a v4 hook address against the active chain's PoolManager
  // (getHookPermissions) before saving it. Empty input = hookless v4 pool
  // (allowed - hooks are optional in v4). On success the permissions summary is
  // sent to the server so the LLM prompt and the swap card can factor the hook
  // semantics (dynamic fees, KYC, MEV…) into the decision.
  const handleValidateAndSaveHook = async () => {
    const raw = v4HooksAddress.trim();
    if (!raw) {
      setHookStatus('- No hook — routing through the hookless v4 pool.');
      setV4HookPermissions('');
      handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { v4HooksAddress: '', v4HookPermissions: '' });
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      setHookStatus('Invalid hook address — expected 0x followed by 40 hex characters.');
      return;
    }
    const poolManager = V4_POOL_MANAGER_BY_CHAIN[wagmiChainIdNum as number];
    if (!poolManager) {
      setHookStatus(
        `— Hook validation needs a v4-enabled chain (Unichain Sepolia / Unichain / Ethereum). Current chain: ${CHAIN_NAMES[wagmiChainIdNum as number] ?? `chain ${wagmiChainIdNum}`}.`
      );
      return;
    }
    const ethereum = await getActiveProvider();
    if (!ethereum) {
      setHookStatus('— Connect a wallet first — the hook is validated against the on-chain PoolManager.');
      return;
    }
    try {
      const result = await ethereum.request({
        method: 'eth_call',
        params: [
          {
            to: poolManager,
            data: encodeFunctionData({
              abi: POOL_MANAGER_GET_HOOK_PERMISSIONS_ABI,
              functionName: 'getHookPermissions',
              args: [raw as `0x${string}`]
            })
          },
          'latest'
        ]
      });
      const flags = decodeHookPermissionFlags(result as string);
      const permStr = HOOK_PERMISSION_FLAGS.map((f) => `${f}=${flags[f] ? 1 : 0}`).join(' ');
      const active = HOOK_PERMISSION_FLAGS.filter((f) => flags[f]);
      setV4HookPermissions(permStr);
      setHookStatus(
        active.length > 0
          ? `- Hook verified on PoolManager — permissions: ${active.join(', ')}.`
          : '— Hook verified on PoolManager — it declares no lifecycle permissions (behaves like a hookless pool).'
      );
      handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { v4HooksAddress: raw, v4HookPermissions: permStr });
    } catch (err) {
      console.warn('getHookPermissions failed:', err);
      setHookStatus('— Could not read hook permissions (is this a deployed contract on the active chain?). The hook was NOT saved.');
    }
  };

  const handleSaveKeys = async (newKeys: { [provider: string]: string }) => {
    // Validate-before-save: when the active provider needs a key and one is
    // typed, prove it works against the real provider API before persisting.
    // A rejected key keeps the modal open with a red alert. Keyless providers
    // with a probe (Ollama) are connectivity-checked instead. If the local
    // orchestrator itself is unreachable, save locally but warn (amber).
    const meta = PROVIDER_META[currentProvider];
    const key = (newKeys[currentProvider] || '').trim();
    if (meta?.keylessProbe) {
      setLlmTest({ state: 'testing', message: 'Checking Ollama server & model before saving…' });
      const probe = await probeCredentials({ llmProvider: currentProvider });
      if (!probe.ok) {
        setLlmTest({ state: 'fail', message: probe.message });
        return; // broken Ollama config is never saved — modal stays open
      }
      setLlmTest({ state: 'ok', message: `Saved — ${probe.message}` });
    } else if (meta?.needsKey && key) {
      setLlmTest({ state: 'testing', message: 'Validating key before saving…' });
      const probe = await probeCredentials({ llmProvider: currentProvider, apiKey: key });
      if (!probe.ok) {
        if (probe.message.startsWith('Cannot reach')) {
          setLlmTest({ state: 'warn', message: 'Saved locally — orchestrator unreachable to validate the key.' });
        } else {
          setLlmTest({ state: 'fail', message: probe.message });
          return; // broken key is never saved — modal stays open
        }
      } else {
        setLlmTest({ state: 'ok', message: `Saved — ${probe.message}` });
      }
    }
    setApiKeys(newKeys);
    localStorage.setItem('trust_ai_api_keys', JSON.stringify(newKeys));
    setIsModalOpen(false);
    handleUpdateSettings(undefined, undefined, undefined, newKeys);
  };

  // Validates + saves the per-signal budget for the active pair's base token.
  // Rules: > 0 always; for WETH/ETH-base pairs with a connected wallet it must
  // stay below the wallet's native ETH balance (never the whole wallet, never
  // zero). Other tokens skip the balance check (chain-aware balances = Phase 4).
  const applyBudget = () => {
    const v = Number(budgetDraft);
    if (!Number.isFinite(v) || v <= 0) {
      setBudgetError('Budget must be greater than zero.');
      return;
    }
    if (budgetSymbol === 'WETH' && account && balance && v >= Number(balance)) {
      setBudgetError(`Budget must be smaller than your wallet balance (${balance} ETH).`);
      return;
    }
    setBudgetError(null);
    setMaxTradeAmountEth(v);
    const next = { ...budgetsByToken, [budgetSymbol]: v };
    setBudgetsByToken(next);
    localStorage.setItem('trust_ai_budgets', JSON.stringify(next));
    handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, v);
  };

  const budgetForBase = (base: string) => budgetsByToken[base] ?? 0.25;

  // Evaluates a decision against the cap saved for THAT signal's pair base.
  // Direction is standard DEX (BUY pays quote - receives base; SELL pays base
  // - receives quote) and amounts are sized in BASE units for both directions,
  // so the cap comparison is direct; the quote leg is derived from the price.
  const budgetCheckFor = (decision: AIDecision, trigger: MarketTrigger) => {
    const [baseSym, quoteSym] = (trigger?.pair || 'WETH/USDC').split('/');
    const isBuy = decision.action === 'BUY';
    const price = trigger?.current_price > 0 ? trigger.current_price : 1;
    const cap = budgetForBase(baseSym);
    const amt = Math.max(0, decision.suggested_amount_eth); // base-token quantity
    const spend = isBuy ? amt * price : amt;
    const spendSym = isBuy ? quoteSym : baseSym;
    const out = isBuy ? amt : amt * price;
    const outSym = isBuy ? baseSym : quoteSym;
    return {
      baseSym,
      spend,
      spendSym,
      out,
      outSym,
      cap,
      amt,
      ok: amt <= cap + 1e-9,
      summary: `${fmtPrice(spend)} ${spendSym} → ~${fmtPrice(out)} ${outSym}`
    };
  };

  // Cancel / dismiss the current signal: hides the swap card (Undo available)
  // until the next decision arrives. The signal lock (tx in flight) also blocks
  // dismissal: while the wallet popup is open the only way out is rejecting
  // there.
  const handleCancelSignal = () => {
    if (isSwapInFlight || txStatus === 'pending' || !latestEvent) return;
    setDismissedEventId(latestEvent.id);
    setTxStatus('idle');
    setTxStep(null);
    setActiveTxHash(null);
  };

  const clearAllStoredKeys = () => {
    const empty: { [provider: string]: string } = {};
    setApiKeys(empty);
    localStorage.setItem('trust_ai_api_keys', JSON.stringify(empty));
    setKeysNotice('Stored API keys cleared from this browser. Keys were never saved server-side.');
    handleUpdateSettings(undefined, undefined, undefined, empty);
  };

  // Composes the full endpoint URL from provider + network + key (or a custom
  // URL for QuickNode/Custom), then persists locally + pushes to the server so
  // the Rust engine picks it up on its next start (/api/rpc-config).
  const buildRpcUrl = (): string => {
    if (rpcProvider === 'custom' || rpcProvider === 'quicknode') {
      return rpcCustomUrl.trim();
    }
    const key = rpcKey.trim();
    // Provider-specific network subdomains (official endpoint shapes):
    const alchemyNet: Record<string, string> = {
      sepolia: 'eth-sepolia', mainnet: 'eth-mainnet',
      'unichain-sepolia': 'unichain-sepolia', unichain: 'unichain-mainnet'
    };
    const infuraNet: Record<string, string> = {
      sepolia: 'sepolia', mainnet: 'mainnet',
      'unichain-sepolia': 'unichain-sepolia', unichain: 'unichain-mainnet'
    };
    if (rpcProvider === 'alchemy') {
      const net = alchemyNet[rpcNetwork] || 'eth-sepolia';
      return `https://${net}.g.alchemy.com/v2/${key}`;
    }
    if (rpcProvider === 'infura') {
      const net = infuraNet[rpcNetwork] || 'sepolia';
      return `https://${net}.infura.io/v3/${key}`;
    }
    return '';
  };

  // Shared probe: asks the local orchestrator to validate the credential for
  // real (eth_chainId+eth_blockNumber for RPC; a minimal billed request for
  // LLM keys). The key travels only to localhost and is never logged.
  const probeCredentials = async (payload: {
    rpcUrl?: string;
    rpcNetwork?: string;
    llmProvider?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await fetch('http://localhost:3001/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return { ok: false, message: `Validation service error (HTTP ${res.status}).` };
      const data = await res.json();
      if (payload.rpcUrl !== undefined && data.rpc) {
        return data.rpc.ok
          ? { ok: true, message: `Valid RPC — chain ${data.rpc.chainId}, block #${data.rpc.blockNumber}` }
          : { ok: false, message: data.rpc.error ?? 'unknown RPC error' };
      }
      if (payload.llmProvider !== undefined && data.llm) {
        // Provider-neutral wording: the same probe serves keyed providers
        // ("Test Key") and keyless ones like Ollama ("Test Connection").
        return data.llm.ok
          ? { ok: true, message: `${data.llm.model ?? payload.llmProvider} responded` }
          : { ok: false, message: data.llm.error ?? 'unknown error' };
      }
      return { ok: false, message: 'Unexpected validation response.' };
    } catch {
      return { ok: false, message: 'Cannot reach the local orchestrator (:3001). Is the server running?' };
    }
  };

  // Test Connection: probe the composed RPC URL without saving anything.
  const handleTestRpc = async () => {
    const url = buildRpcUrl();
    if (!url) {
      setRpcTest({ state: 'fail', message: 'Paste your provider API key (or a full https:// URL) first.' });
      return;
    }
    setRpcError(null);
    setRpcTest({ state: 'testing', message: null });
    const result = await probeCredentials({ rpcUrl: url, rpcNetwork });
    setRpcTest({ state: result.ok ? 'ok' : 'fail', message: result.message });
  };

  // Test Key / Test Connection for the AI provider: probes the typed key
  // (or, for keyless providers like Ollama, just the configured endpoint +
  // model) without saving anything.
  const handleTestLlmKey = async () => {
    const meta = PROVIDER_META[currentProvider];
    if (meta?.keylessProbe) {
      // Ollama-style: no key — validate server reachability + model presence.
      setLlmTest({ state: 'testing', message: null });
      const result = await probeCredentials({ llmProvider: currentProvider });
      setLlmTest({ state: result.ok ? 'ok' : 'fail', message: result.message });
      return;
    }
    const key = (apiKeys[currentProvider] || '').trim();
    if (!key) {
      setLlmTest({ state: 'fail', message: 'Type the API key first.' });
      return;
    }
    setLlmTest({ state: 'testing', message: null });
    const result = await probeCredentials({ llmProvider: currentProvider, apiKey: key });
    setLlmTest({ state: result.ok ? 'ok' : 'fail', message: result.message });
  };

  // Save RPC: validates the endpoint for real BEFORE persisting — a broken or
  // rate-limited link is never saved (visible red alert instead).
  const handleSaveRpc = async () => {
    const url = buildRpcUrl();
    if (rpcProvider === 'alchemy' || rpcProvider === 'infura') {
      if (!rpcKey.trim()) {
        setRpcError('Paste your provider API key to build the endpoint URL.');
        setRpcTest({ state: 'fail', message: null });
        return;
      }
    } else if (!/^https?:\/\//i.test(url)) {
      setRpcError('Paste the full endpoint URL provided by your RPC provider (https://…).');
      setRpcTest({ state: 'fail', message: null });
      return;
    }
    setRpcError(null);
    setRpcTest({ state: 'testing', message: 'Validating endpoint before saving…' });
    const probe = await probeCredentials({ rpcUrl: url, rpcNetwork });
    if (!probe.ok) {
      setRpcTest({ state: 'fail', message: probe.message });
      return;
    }
    localStorage.setItem('trust_ai_rpc', JSON.stringify({ provider: rpcProvider, network: rpcNetwork, url }));
    localStorage.setItem('trust_ai_rpc_network', rpcNetwork);
    setRpcSaved({ provider: rpcProvider, network: rpcNetwork, maskedUrl: maskRpcUrl(url) });
    setRpcTest({ state: 'ok', message: `Saved — ${probe.message}` });
    handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      rpcUrl: url,
      rpcProvider,
      rpcNetwork
    });
  };

  const handleClearRpc = () => {
    localStorage.removeItem('trust_ai_rpc');
    localStorage.removeItem('trust_ai_rpc_network');
    setRpcSaved(null);
    setRpcKey('');
    setRpcCustomUrl('');
    setRpcTest({ state: 'idle', message: null });
    handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      rpcUrl: '',
      rpcProvider: rpcProvider,
      rpcNetwork
    });
  };

  // On load/switch, re-push the selected pair and network/RPC link so the
  // orchestrator and engine stay in sync without the user re-choosing.
  // PUSH GUARD: the pair is pushed at most once per value — WS echoes call
  // this effect again with the same pair, and re-pushing would re-broadcast
  // and re-echo forever (server ping-pong). User actions (pair picker, flip,
  // preset chips) always push explicitly and update pushedPairRef.
  useEffect(() => {
    // ORDER MATTERS: the saved RPC link is pushed FIRST, the pair's network
    // SECOND. The server applies whichever rpcNetwork lands last — pushing
    // the RPC link afterwards used to overwrite the pair's freshly-set
    // network with the link's stale stored network (e.g. 'sepolia'), and
    // every route label fell back to UNICHAIN-SEPOLIA again.
    try {
      const raw = localStorage.getItem('trust_ai_rpc');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.url) {
          handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
            rpcUrl: o.url,
            rpcProvider: o.provider || 'custom',
            rpcNetwork: o.network || 'sepolia'
          });
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    if (selectedPair !== 'ALL' && pushedPairRef.current !== selectedPair) {
      pushedPairRef.current = selectedPair;
      // Push the pair's EXECUTION NETWORK together with the pair: the server's
      // route label, calldata network and live-price pool all derive from it.
      // Without this, a pair restored after a server restart fell back to
      // .env NETWORK_NAME (sepolia → UNICHAIN-SEPOLIA on every route label).
      // rpcNetwork without an rpcUrl is applied standalone server-side and
      // never touches a saved RPC link.
      if (selectedPair.includes('/')) {
        const [b, q] = selectedPair.split('/');
        const netKey = pairChainKey ?? storedOrDefaultChainKeyForPair(b, q);
        handleUpdateSettings(undefined, undefined, undefined, undefined, selectedPair, undefined, undefined, netKey ? { rpcNetwork: netKey } : undefined);
      } else {
        handleUpdateSettings(undefined, undefined, undefined, undefined, selectedPair);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPair]);

  // Keep the custom pair builder in sync when the orchestrator reports a pair
  // selection (SYSTEM_INIT / SETTINGS_UPDATED or a preset chip click). The
  // execution chain is restored from the pair itself only while unset, so a
  // user-picked network tab is never overridden by a settings echo.
  useEffect(() => {
    if (selectedPair !== 'ALL' && selectedPair.includes('/')) {
      const [b, q] = selectedPair.split('/');
      setPairBase(b);
      setPairQuote(q);
      setPairChainKey((cur) => cur ?? storedOrDefaultChainKeyForPair(b, q) ?? null);
    }
  }, [selectedPair]);

  const openTokenPicker = (side: 'base' | 'quote') => {
    setTokenSearch('');
    setIsTokenPickerOpen(side);
  };

  // Picking a token in the builder immediately monitors BASE/QUOTE (DEX-like).
  const pickBuilderToken = (side: 'base' | 'quote', symbol: string) => {
    setIsTokenPickerOpen(false);
    const base = side === 'base' ? symbol : pairBase;
    const quote = side === 'quote' ? symbol : pairQuote;
    if (base === quote) return;
    setPairBase(base);
    setPairQuote(quote);
    const pairId = `${base}/${quote}`;
    pushedPairRef.current = pairId;
    // Sync the ref synchronously: any WS echo arriving before React commits
    // (or from a lingering socket) must see the NEW value, not the old one.
    selectedPairRef.current = pairId;
    setSelectedPair(pairId);
    // Execution network = the picker tab the token was picked under (falls
    // back to the pair's default chain for preset chips / searches that
    // ignore tabs). This is what makes Rede + Par one single decision.
    const chainKey =
      selectedNetworkFilter !== 'ALL' ? networkKeyForChainId(selectedNetworkFilter) : pickNetworkForPair(base, quote);
    setPairChainKey(chainKey ?? null);
    applyPairNetwork(base, quote, chainKey ?? null, pairId);
    handleUpdateSettings(undefined, undefined, undefined, undefined, pairId);
  };

  const handleSwapPair = () => {
    if (pairBase === pairQuote) return;
    setPairBase(pairQuote);
    setPairQuote(pairBase);
    const pairId = `${pairQuote}/${pairBase}`;
    pushedPairRef.current = pairId;
    selectedPairRef.current = pairId;
    setSelectedPair(pairId);
    // Flipping the pair keeps the execution chain (both sides were picked
    // under the same network tab).
    applyPairNetwork(pairQuote, pairBase, pairChainKey, pairId);
    handleUpdateSettings(undefined, undefined, undefined, undefined, pairId);
  };


  // Manual playground trigger: asks the server to broadcast a synthetic
  // NEW_DECISION with real Uniswap Router calldata for the Unichain Sepolia
  // mUSDC/mUSDT pool, so the swap card can be exercised on demand without
  // waiting for the Rust engine or the AI throttle.
  const handleForceTestSwap = async () => {
    try {
      setTxStatus('pending');
      setTxStep(null);
      const res = await fetch('http://localhost:3001/api/force-swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: 'mUSDC/mUSDT',
          suggested_amount_eth: maxTradeAmountEth
        })
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'unknown' }));
        setTxStatus('error');
        alert(`Force swap failed: ${JSON.stringify(errBody)}`);
        return;
      }
      setTxStatus('idle');
      setTxStep(null);
    } catch (err) {
      console.error('Force swap request failed:', err);
      setTxStatus('error');
    }
  };

  // Header network dropdown REMOVED: the execution network is derived from the
  // monitored pair (see pairNetworks.ts). applyPairNetwork pushes the pair's
  // server network key via /api/settings — the server maps it to the swap
  // route even without a configured RPC URL.
  const applyPairNetwork = (base: string, quote: string, chainKey: string | null, pairId: string) => {
    const netKey = chainKey ?? pickNetworkForPair(base, quote);
    if (!netKey) return;
    const chainId = chainIdForNetworkKey(netKey);
    setRpcNetwork(netKey);
    setPairChainKey(netKey);
    if (chainId !== undefined) setSelectedNetworkFilter(chainId);
    try { localStorage.setItem('trust_ai_pair_chain', String(chainId ?? '')); } catch { /* private mode */ }
    // Push the pair's network to the server — the swap route follows the
    // pair even without an RPC URL configured (server maps the key alone).
    handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { rpcNetwork: netKey });
    void pairId;
  };

  // Sync the picker's network filter with the pair's execution chain (the
  // filter is saved for the next load; the picker still opens on 'ALL').
  useEffect(() => {
    if (selectedPair === 'ALL' || !selectedPair.includes('/')) return;
    const [b, q] = selectedPair.split('/');
    const chainId = isMockPair(b, q) ? MOCK_PAIR_CHAIN_ID : knownChainOf(b) ?? knownChainOf(q);
    if (chainId === undefined) return;
    try {
      // Don't clobber a user-picked tab that still supports the pair: the
      // mainnet-derived chain id used to overwrite e.g. a Base pick after
      // every pair change/echo, and the next reload silently restored the
      // Ethereum tab. Only fill the storage when it is empty/stale.
      const stored = parseInt(localStorage.getItem('trust_ai_pair_chain') ?? '', 10);
      const storedSupportsPair = !Number.isNaN(stored)
        && tokenSupportedOnChain(b, stored) && tokenSupportedOnChain(q, stored);
      if (!storedSupportsPair) localStorage.setItem('trust_ai_pair_chain', String(chainId));
    } catch { /* private mode */ }
  }, [selectedPair]);

  return (
    <div style={{ padding: '24px', maxWidth: '1440px', margin: '0 auto' }}>
      {/* Top Navbar */}
      <header className="glass-panel" style={{ padding: '14px 24px', marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px', position: 'relative', zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem' }}>
            🪅
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ fontSize: '1.3rem', fontWeight: 800, letterSpacing: '-0.5px', color: '#ffffff' }}>TRusT-AI</h1>
              <span className="badge badge-cyan font-mono" style={{ fontSize: '0.68rem', padding: '2px 8px' }}>v1.0.0</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Neutral Web3 Wallet Connect */}
          <button
            onClick={handleConnectWallet}
            title={
              account
                ? `${account} · ${wagmiChainIdNum ? getChainName(wagmiChainIdNum) : chainMetaOf(chainId).name}${balance !== null ? ` · ${balance} ETH` : ''}${ensName ? ` · ${ensName}` : ''}${liveBlockNumber > 0 ? ` · Block #${liveBlockNumber}` : ''}${wagmiChainIdNum && isTestnet(wagmiChainIdNum) ? ' · (testnet)' : '' }`
                : 'Connect Web3 wallet (MetaMask/Rabby)'
            }
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-main)',
              fontWeight: 600,
              padding: '6px 12px',
              borderRadius: '999px',
              fontSize: '0.78rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s ease'
            }}
          >
            <Wallet size={13} style={{ color: 'var(--text-muted)' }} />
            {account ? (
              <>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-green)' }} />
                <span className="font-mono" style={{ fontSize: '0.76rem' }}>{account.slice(0, 6)}…{account.slice(-4)}</span>
                {isConnected && (
                  // span (not button): nesting a <button> inside the wallet
                  // <button> is invalid DOM (validateDOMNesting warning) and
                  // breaks the header's render reconciliation.
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); disconnect(); setBalance(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); disconnect(); setBalance(null); } }}
                    title="Disconnect wallet"
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.7rem', padding: '2px 4px', borderRadius: '4px', display: 'inline-flex' }}
                  >
                    ✕
                  </span>
                )}
              </>
            ) : isConnectingWallet ? (
              <span>Connecting…</span>
            ) : (
              <span>Connect Wallet</span>
            )}
          </button>

          {/* Monitored-network pill — read-only: the execution network is
              derived from the monitored pair (picked under a network tab in
              the unified pair picker). No dropdown, no state divergence. */}
          {(() => {
            const cid = pairChainKey ? chainIdForNetworkKey(pairChainKey) : undefined;
            if (cid === undefined) return null;
            const b = getNetworkBadgeInfo(cid);
            return (
              <span
                className="header-pill"
                title={`Execution network: ${b.label} — derived from the monitored pair. Change it in the pair picker (network tabs).`}
                style={{ padding: '5px 10px', gap: '6px', margin: 0, cursor: 'default' }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: b.color, display: 'inline-block', flexShrink: 0 }} />
                <span style={{ fontSize: '0.66rem', fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{b.label}</span>
              </span>
            );
          })()}

          {/* Dedicated Status Pills: Chip (Engine) + Wi-Fi (Network WS) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              className="header-pill"
              title={engineAlive ? 'Rust Engine: streaming market triggers' : 'Rust Engine: waiting for first trigger'}
              style={{ padding: '5px 10px', gap: '6px', margin: 0 }}
            >
              <span className={engineAlive ? 'dot-online' : 'dot-paused'} style={{ width: 6, height: 6 }} />
              <Cpu size={13} style={{ color: engineAlive ? 'var(--accent-green)' : 'var(--accent-amber)' }} />
            </span>

            <span
              className="header-pill"
              title={connected ? 'Gateway WebSocket: live' : 'Gateway WebSocket: offline'}
              style={{ padding: '5px 10px', gap: '6px', margin: 0 }}
            >
              <span className={connected ? 'dot-online' : 'dot-paused'} style={{ width: 6, height: 6 }} />
              <Wifi size={13} style={{ color: connected ? 'var(--accent-green)' : 'var(--accent-red)' }} />
            </span>
          </div>

          {/* Compact Red Power Button for Emergency Stop */}
          <button
            className={`emergency-power-btn ${emergencyPause ? 'paused' : ''}`}
            onClick={() => handleUpdateSettings(undefined, !emergencyPause)}
            title={emergencyPause ? 'Emergency Pause Active — Click to Resume Agent' : 'Emergency Stop: Pause Agent'}
          >
            <PauseCircle size={18} />
          </button>

          {/* Gear Icon Settings Trigger ⚙️ */}
          <button
            onClick={() => setIsModalOpen(true)}
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-main)',
              padding: '8px',
              borderRadius: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease'
            }}
            title="Open Advanced Settings ⚙️"
          >
            <Settings size={17} />
          </button>
        </div>
      </header>

      {/* Tabbed Settings Modal ⚙️ */}
      {isModalOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 940 }} onClick={() => setIsModalOpen(false)} />
          <div
            className="glass-panel"
            style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '580px', maxWidth: 'calc(100vw - 32px)', padding: '24px', borderRadius: '16px', zIndex: 950, maxHeight: '85vh', overflowY: 'auto', background: '#121214', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings size={18} style={{ color: 'var(--accent-violet)' }} />
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>TRusT-AI Configuration</h2>
              </div>
              <button onClick={() => setIsModalOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
            </div>

            {/* 3 Tabs Header */}
            <div className="modal-tabs">
              <button className={`modal-tab-btn ${settingsTab === 'risk' ? 'active' : ''}`} onClick={() => setSettingsTab('risk')}>
                <ShieldAlert size={14} /> Risk & Limits
              </button>
              <button className={`modal-tab-btn ${settingsTab === 'v4' ? 'active' : ''}`} onClick={() => setSettingsTab('v4')}>
                <Layers size={14} /> Uniswap v4 & Hooks
              </button>
              <button className={`modal-tab-btn ${settingsTab === 'network' ? 'active' : ''}`} onClick={() => setSettingsTab('network')}>
                <Brain size={14} /> Network & AI
              </button>
            </div>

            {/* Tab 1: Risk & Limits */}
            {settingsTab === 'risk' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                {/* Max Allowed Slippage */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px' }}>
                    <span>Max Allowed Slippage (Uniswap Router)</span>
                    <span className="font-mono" style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>
                      {maxSlippageBps} bps ({(maxSlippageBps / 100).toFixed(2)}%)
                    </span>
                  </div>
                  <input
                    type="range" min="10" max="300" step="10"
                    value={maxSlippageBps}
                    onChange={(e) => handleUpdateSettings(undefined, undefined, Number(e.target.value))}
                  />
                </div>

                {/* Per-Signal Trade Budget */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Wallet size={14} style={{ color: 'var(--accent-green)' }} />
                      Max Trade Budget per Signal ({budgetSymbol})
                    </span>
                    <span className="font-mono" style={{ color: 'var(--accent-green)', fontWeight: 600 }}>
                      {maxTradeAmountEth} {budgetSymbol}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="number" min="0.01" step="0.01"
                      value={budgetDraft}
                      onChange={(e) => { setBudgetDraft(e.target.value); setBudgetError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') applyBudget(); }}
                      style={{ flex: 1, padding: '8px 10px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }}
                    />
                    <button onClick={applyBudget} style={{ padding: '8px 14px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid var(--accent-green)', color: 'var(--accent-green)', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>Apply</button>
                  </div>
                  {budgetError && <div style={{ fontSize: '0.72rem', color: 'var(--accent-red)', marginTop: '4px' }}>{budgetError}</div>}
                </div>

                {/* AI Analysis Interval */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Clock size={14} style={{ color: 'var(--accent-violet)' }} /> Interval Between AI Analyses
                    </span>
                    <span className="font-mono" style={{ color: 'var(--accent-violet)', fontWeight: 600 }}>{analysisIntervalSec}s</span>
                  </div>
                  <input
                    type="range" min="5" max="120" step="5"
                    value={analysisIntervalSec}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setAnalysisIntervalSec(val);
                      handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, val);
                    }}
                  />
                </div>
              </div>
            )}

            {/* Tab 2: Uniswap v4 & Hooks */}
            {settingsTab === 'v4' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  Swap Route: <span style={{ color: 'var(--accent-violet)' }}>Uniswap v4</span> — Universal Router · Hooks support
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>Pool Fee Tier</div>
                        <input type="number" value={v4Fee} onChange={(e) => setV4Fee(Number(e.target.value))} onBlur={() => handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { v4Fee })} style={{ width: '100%', padding: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>Tick Spacing</div>
                        <input type="number" value={v4TickSpacing} onChange={(e) => setV4TickSpacing(Number(e.target.value))} onBlur={() => handleUpdateSettings(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { v4TickSpacing })} style={{ width: '100%', padding: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }} />
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>Hook Address</div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input type="text" placeholder="0x0000…0000 (empty = hookless)" value={v4HooksAddress} onChange={(e) => setV4HooksAddress(e.target.value)} style={{ flex: 1, padding: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }} />
                        <button onClick={handleValidateAndSaveHook} style={{ padding: '8px 12px', background: 'rgba(168, 85, 247, 0.15)', border: '1px solid var(--accent-violet)', color: 'var(--accent-violet)', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>Validate</button>
                      </div>
                      {hookStatus && <div style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)', marginTop: '4px' }}>{hookStatus}</div>}
                    </div>
                </div>

                <button className="force-swap-btn" onClick={handleForceTestSwap} disabled={txStatus === 'pending'}>
                  Force Test Swap — mUSDC/mUSDT (Unichain Sepolia)
                </button>
              </div>
            )}

            {/* Tab 3: Network, RPC & AI */}
            {settingsTab === 'network' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>AI Provider</div>
                  <select value={currentProvider} onChange={(e) => handleUpdateSettings(e.target.value)} style={{ width: '100%', padding: '9px', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem' }}>
                    <option value="mock">Mock AI (built-in)</option>
                    <option value="deepseek">DeepSeek AI</option>
                    <option value="openai">OpenAI ChatGPT</option>
                    <option value="anthropic">Anthropic Claude</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="ollama_cloud">Ollama Cloud (API key)</option>
                    <option value="ollama">Local Ollama</option>
                  </select>
                </div>

                {(PROVIDER_META[currentProvider]?.needsKey || PROVIDER_META[currentProvider]?.keylessProbe) && (
                  <div>
                    {PROVIDER_META[currentProvider]?.needsKey ? (
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>API Key ({PROVIDER_META[currentProvider].name})</div>
                    ) : (
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                        {PROVIDER_META[currentProvider].name}
                        <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-dim)', marginLeft: '6px' }}>
                          runs locally — no key required; the server probes the endpoint + model
                        </span>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {PROVIDER_META[currentProvider]?.needsKey && (
                        <input type="password" placeholder={PROVIDER_META[currentProvider].placeholder} value={apiKeys[currentProvider] || ''} onChange={(e) => { setApiKeys({ ...apiKeys, [currentProvider]: e.target.value }); setLlmTest({ state: 'idle', message: null }); }} style={{ flex: 1, padding: '9px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }} />
                      )}
                      <button
                        onClick={handleTestLlmKey}
                        disabled={llmTest.state === 'testing'}
                        style={{ padding: '8px 12px', background: 'rgba(168, 85, 247, 0.15)', border: '1px solid var(--accent-violet)', color: 'var(--accent-violet)', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 700, cursor: llmTest.state === 'testing' ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                      >
                        {llmTest.state === 'testing' ? 'Testing…' : PROVIDER_META[currentProvider]?.keylessProbe ? 'Test Connection' : 'Test Key'}
                      </button>
                    </div>
                    {llmTest.state !== 'idle' && llmTest.message && (
                      <div style={{
                        marginTop: '6px', padding: '7px 10px', borderRadius: '6px', fontSize: '0.72rem', fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: '6px',
                        background: llmTest.state === 'ok' ? 'rgba(56, 239, 125, 0.10)' : llmTest.state === 'fail' ? 'rgba(255, 71, 87, 0.10)' : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${llmTest.state === 'ok' ? 'rgba(56, 239, 125, 0.4)' : llmTest.state === 'fail' ? 'rgba(255, 71, 87, 0.45)' : 'var(--border-color)'}`,
                        color: llmTest.state === 'ok' ? '#38ef7d' : llmTest.state === 'fail' ? '#ff4757' : 'var(--text-muted)'
                      }}>
                        {llmTest.state === 'ok' ? <CheckCircle2 size={13} /> : llmTest.state === 'fail' ? <XCircle size={13} /> : <RefreshCw size={13} className="spin-icon" />}
                        {llmTest.message}
                      </div>
                    )}
                  </div>
                )}

                {/* RPC Plug-in */}
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Cpu size={14} style={{ color: 'var(--accent-violet)' }} /> RPC Node Plug-in
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <select value={rpcProvider} onChange={(e) => { setRpcProvider(e.target.value); setRpcTest({ state: 'idle', message: null }); setRpcError(null); }} style={{ flex: 1, padding: '8px', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.8rem' }}>
                      <option value="alchemy">Alchemy</option>
                      <option value="infura">Infura</option>
                      <option value="quicknode">QuickNode</option>
                      <option value="custom">Custom RPC</option>
                    </select>
                    <select value={rpcNetwork} onChange={(e) => { setRpcNetwork(e.target.value); setRpcTest({ state: 'idle', message: null }); }} style={{ flex: 1, padding: '8px', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.8rem' }}>
                      <option value="sepolia">Sepolia</option>
                      <option value="unichain-sepolia">Unichain Sepolia</option>
                      <option value="unichain">Unichain</option>
                      <option value="mainnet">Ethereum Mainnet</option>
                    </select>
                  </div>
                  <input type="text" placeholder="RPC key or full URL..." value={rpcProvider === 'alchemy' || rpcProvider === 'infura' ? rpcKey : rpcCustomUrl} onChange={(e) => { rpcProvider === 'alchemy' || rpcProvider === 'infura' ? setRpcKey(e.target.value) : setRpcCustomUrl(e.target.value); setRpcTest({ state: 'idle', message: null }); }} style={{ width: '100%', padding: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '0.8rem', marginBottom: '8px' }} />
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button onClick={handleTestRpc} disabled={rpcTest.state === 'testing'} style={{ padding: '6px 12px', background: 'rgba(168, 85, 247, 0.15)', border: '1px solid var(--accent-violet)', color: 'var(--accent-violet)', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 700, cursor: rpcTest.state === 'testing' ? 'wait' : 'pointer' }}>
                      {rpcTest.state === 'testing' ? 'Testing…' : 'Test Connection'}
                    </button>
                    <button onClick={handleSaveRpc} disabled={rpcTest.state === 'testing'} style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>Save RPC</button>
                    <button onClick={handleClearRpc} style={{ padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', borderRadius: '6px', fontSize: '0.75rem', cursor: 'pointer' }}>Clear</button>
                  </div>
                  {(rpcTest.message || rpcError) && (
                    <div style={{
                      marginTop: '8px', padding: '7px 10px', borderRadius: '6px', fontSize: '0.72rem', fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: '6px',
                      background: rpcTest.state === 'ok' ? 'rgba(56, 239, 125, 0.10)' : rpcTest.state === 'fail' || rpcError ? 'rgba(255, 71, 87, 0.10)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${rpcTest.state === 'ok' ? 'rgba(56, 239, 125, 0.4)' : rpcTest.state === 'fail' || rpcError ? 'rgba(255, 71, 87, 0.45)' : 'var(--border-color)'}`,
                      color: rpcTest.state === 'ok' ? '#38ef7d' : rpcTest.state === 'fail' || rpcError ? '#ff4757' : 'var(--text-muted)'
                    }}>
                      {rpcTest.state === 'ok' ? <CheckCircle2 size={13} /> : rpcTest.state === 'fail' || rpcError ? <XCircle size={13} /> : <RefreshCw size={13} className="spin-icon" />}
                      {rpcTest.message || rpcError}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Modal Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
              <button onClick={() => setIsModalOpen(false)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', borderRadius: '8px', fontSize: '0.8rem', cursor: 'pointer' }}>Close</button>
              <button onClick={() => handleSaveKeys(apiKeys)} style={{ padding: '8px 20px', background: 'linear-gradient(135deg, #a855f7, #d946ef)', border: 'none', color: '#fff', fontWeight: 700, borderRadius: '8px', fontSize: '0.8rem', cursor: 'pointer' }}>Save & Close</button>
            </div>
          </div>
        </>
      )}

      {/* Token Picker Modal - Dynamic Multichain DEX UX (Uniswap-style) */}
      {isTokenPickerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }} onClick={() => setIsTokenPickerOpen(false)}>
          <div className="token-picker-modal" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.3px' }}>
                  Select {isTokenPickerOpen === 'base' ? 'Base' : 'Quote'} Token
                </h2>
                <div style={{ fontSize: '0.73rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                  {selectedNetworkFilter === 'ALL'
                    ? 'Search by symbol, name, or paste contract address (0x…)'
                    : `Searching on ${pickerNetworkLabel(selectedNetworkFilter)} — pairs built here execute on this network`}
                </div>
              </div>
              <button onClick={() => setIsTokenPickerOpen(false)} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', color: 'var(--text-muted)', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ✕
              </button>
            </div>

            {/* Search Box */}
            <div className="token-search-box">
              <input
                autoFocus
                type="text"
                className="token-search-input"
                placeholder="Search symbol, name, or paste address 0x…"
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
              />
              {tokenSearch && (
                <button
                  onClick={() => setTokenSearch('')}
                  style={{ position: 'absolute', right: '12px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  ✕
                </button>
              )}
            </div>

            {/* Quick Select Pills (WETH, USDC, USDT, WBTC...) with Network
                Badge Overlay. On a network tab only tokens with a verified
                contract on THAT chain are shown, and the badge mirrors the tab
                (same as the token list). On 'ALL' they keep the Ethereum badge
                as the canonical launchpad chain. */}
            <div className="quick-pills-container">
              {[
                { symbol: 'WETH', name: 'Wrapped Ether', color: '#627eea', chainId: 1 },
                { symbol: 'USDC', name: 'USD Coin', color: '#2775ca', chainId: 1 },
                { symbol: 'USDT', name: 'Tether USD', color: '#26a17b', chainId: 1 },
                { symbol: 'WBTC', name: 'Wrapped Bitcoin', color: '#f7931a', chainId: 1 },
                { symbol: 'LINK', name: 'Chainlink', color: '#2a5ada', chainId: 1 },
                { symbol: 'UNI', name: 'Uniswap', color: '#ff007a', chainId: 1 },
              ]
                .filter((pill) => selectedNetworkFilter === 'ALL' || tokenSupportedOnChain(pill.symbol, selectedNetworkFilter))
                .map((pill) => {
                const pillChain = selectedNetworkFilter === 'ALL' ? pill.chainId : selectedNetworkFilter;
                const badge = getNetworkBadgeInfo(pillChain);
                const isActive = (isTokenPickerOpen === 'base' ? pairBase : pairQuote) === pill.symbol;
                const logoUrl = TOKEN_LOGOS[pill.symbol];
                return (
                  <button
                    key={pill.symbol}
                    className={`quick-pill-btn ${isActive ? 'active' : ''}`}
                    onClick={() => pickBuilderToken(isTokenPickerOpen, pill.symbol)}
                  >
                    <div className="token-icon-wrapper">
                      {logoUrl ? (
                        <img
                          src={logoUrl}
                          alt={pill.symbol}
                          style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }}
                          onError={(e) => {
                            (e.currentTarget as HTMLElement).style.display = 'none';
                            const fallback = (e.currentTarget.nextElementSibling as HTMLElement);
                            if (fallback) fallback.style.display = 'inline-flex';
                          }}
                        />
                      ) : null}
                      <span
                        className="token-avatar"
                        style={{
                          width: 20,
                          height: 20,
                          fontSize: '0.65rem',
                          background: pill.color,
                          display: logoUrl ? 'none' : 'inline-flex',
                        }}
                      >
                        {pill.symbol.slice(0, 1)}
                      </span>
                      <span className="network-badge-overlay" style={{ background: badge.color }} title={badge.label}>
                        <span className="network-badge-letter" style={{ display: badge.logo ? 'none' : 'block' }}>{badge.symbol}</span>
                        {badge.logo ? (
                          <img
                            src={badge.logo}
                            alt=""
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                              const fallback = e.currentTarget.previousElementSibling as HTMLElement | null;
                              if (fallback) fallback.style.display = 'block';
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <span>{pill.symbol}</span>
                  </button>
                );
              })}
            </div>

            {/* Network Selector — minimal icon dropdown. Picking a token under
                a network sets the pair's execution chain (pairNetworks.ts keeps
                it in sync with the server's per-chain contract map). */}
            <div style={{ position: 'relative', marginBottom: '10px' }}>
              <button
                className="network-chip-btn active"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '7px 12px' }}
                onClick={() => setNetDropdownOpen((v) => !v)}
              >
                {(() => {
                  if (selectedNetworkFilter === 'ALL') return <span style={{ fontSize: '0.74rem', fontWeight: 700 }}>◎ All Networks</span>;
                  const b = getNetworkBadgeInfo(selectedNetworkFilter);
                  return (
                    <>
                      <span style={{ width: 15, height: 15, borderRadius: '50%', background: b.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.48rem', fontWeight: 800, color: '#fff', overflow: 'hidden', flexShrink: 0 }}>
                        {b.logo ? <img src={b.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : b.symbol}
                      </span>
                      <span style={{ fontSize: '0.74rem', fontWeight: 700 }}>{b.label}</span>
                    </>
                  );
                })()}
                <ChevronDown size={12} style={{ color: 'var(--text-dim)' }} />
              </button>
              {netDropdownOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 60, minWidth: 210, marginTop: 4, background: 'rgba(10,14,22,0.97)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 6, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: '0 12px 32px rgba(0,0,0,0.5)' }}>
                  {[
                    { id: 'ALL' as const, label: 'All Networks' },
                    ...PICKER_NETWORKS.map((n) => ({ id: n.chainId as number | 'ALL', label: n.label })),
                  ].map((chip) => {
                    const isActive = selectedNetworkFilter === chip.id;
                    const b = chip.id === 'ALL' ? null : getNetworkBadgeInfo(chip.id as number);
                    return (
                      <button
                        key={chip.id.toString()}
                        onClick={() => { setSelectedNetworkFilter(chip.id); setNetDropdownOpen(false); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%', background: isActive ? 'rgba(120,180,255,0.12)' : 'transparent', color: isActive ? '#fff' : 'var(--text-muted)', fontSize: '0.74rem', fontWeight: isActive ? 700 : 500 }}
                      >
                        {b ? (
                          <span style={{ width: 15, height: 15, borderRadius: '50%', background: b.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.48rem', fontWeight: 800, color: '#fff', overflow: 'hidden', flexShrink: 0 }}>
                            {b.logo ? <img src={b.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : b.symbol}
                          </span>
                        ) : (
                          <span style={{ width: 15, textAlign: 'center', flexShrink: 0 }}>◎</span>
                        )}
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 2px' }}>
              <div style={{ fontSize: '0.73rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Activity size={12} style={{ color: 'var(--accent-cyan)' }} />
                Tokens sorted by 24h volume
              </div>
            </div>

            {/* Token List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '330px', overflowY: 'auto', paddingRight: '2px' }}>
              {pickerTokens
                .filter((t) => isTokenPickerOpen === 'base' ? tokenBySymbol(t.symbol) !== undefined : true)
                .filter((t) => {
                  // Curated counterpart list: on the QUOTE side, price-only
                  // top-100 tokens are capped (registry/mocks are uncapped —
                  // they are the executable catalog, ~10 per network).
                  if (isTokenPickerOpen === 'quote' && !tokenBySymbol(t.symbol)) {
                    const seen = quoteDynamicSeen.current;
                    if (seen.has(t.symbol)) return seen.get(t.symbol)!;
                    seen.set(t.symbol, (seen.size ?? 0) < MAX_DYNAMIC_TOKENS_PER_TAB);
                  }
                  return true;
                })
                .filter((t) => {
                  if (selectedNetworkFilter === 'ALL') return true;
                  // Catalog tokens (registry + mocks) match via the per-chain
                  // coverage mirror — the SAME SYMBOL has a verified contract
                  // on Arbitrum/Base/Polygon/Unichain even though its mainnet
                  // ADDRESS is what the registry stores. Known-chain logic
                  // (mainnet for registry) would otherwise pin every catalog
                  // token to the Ethereum tab and leave the other tabs EMPTY.
                  if (tokenBySymbol(t.symbol)) return tokenSupportedOnChain(t.symbol, selectedNetworkFilter);
                  // Dynamic top-100 tokens match via the CoinGecko platform
                  // map (real chains where the token is deployed).
                  const tokenChains = t.chains ?? (t.chainId !== undefined ? [t.chainId] : []);
                  return tokenChains.includes(selectedNetworkFilter);
                })
                .filter(
                  (t) =>
                    t.symbol.toLowerCase().includes(tokenSearch.toLowerCase()) ||
                    t.name.toLowerCase().includes(tokenSearch.toLowerCase()) ||
                    (t.address && t.address.toLowerCase().includes(tokenSearch.toLowerCase()))
                )
                .map((token) => {
                  const disabled =
                    (isTokenPickerOpen === 'base' && token.symbol === pairQuote) ||
                    (isTokenPickerOpen === 'quote' && token.symbol === pairBase);
                  // Badge chain: when a network tab is active, the badge
                  // shows THAT chain (the same symbol has a verified per-chain
                  // contract — TOKEN_ADDRESS_BY_CHAIN — so the overlay reflects
                  // where the pair will execute). On 'ALL', registry/mocks keep
                  // their catalog chain (mainnet / Unichain Sepolia) and
                  // dynamic tokens show their real primary chain from the
                  // CoinGecko platform map. Only app-supported chains get a
                  // badge (getNetworkBadgeInfo defaults unknown ids to Sepolia
                  // — never render that for foreign chains).
                  const supportedBadgeChains = new Set([1, 11155111, 1301, 130, 42161, 8453, 137]);
                  const knownChain =
                    selectedNetworkFilter !== 'ALL'
                      ? selectedNetworkFilter
                      : knownChainOf(token.symbol) ?? token.chains?.[0] ?? token.chainId;
                  const badge = knownChain !== undefined && supportedBadgeChains.has(knownChain) ? getNetworkBadgeInfo(knownChain) : null;

                  return (
                    <button
                      key={token.symbol}
                      disabled={disabled}
                      className="token-row-item"
                      onClick={() => pickBuilderToken(isTokenPickerOpen, token.symbol)}
                    >
                      <div className="token-icon-wrapper">
                        {token.logoURI ? (
                          <img
                            src={token.logoURI}
                            alt={token.symbol}
                            style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                              const fallback = (e.currentTarget.nextElementSibling as HTMLElement);
                              if (fallback) fallback.style.display = 'inline-flex';
                            }}
                          />
                        ) : null}
                        <span
                          className="token-avatar"
                          style={{
                            width: 32,
                            height: 32,
                            background: token.color ?? '#3a4354',
                            display: token.logoURI ? 'none' : 'inline-flex',
                          }}
                        >
                          {token.symbol.slice(0, 1)}
                        </span>
                        {badge && (
                          <span className="network-badge-overlay" style={{ background: badge.color }} title={badge.label}>
                            <span className="network-badge-letter" style={{ display: badge.logo ? 'none' : 'block' }}>{badge.symbol}</span>
                            {badge.logo ? (
                              <img
                                src={badge.logo}
                                alt=""
                                onError={(e) => {
                                  (e.currentTarget as HTMLElement).style.display = 'none';
                                  const fallback = e.currentTarget.previousElementSibling as HTMLElement | null;
                                  if (fallback) fallback.style.display = 'block';
                                }}
                              />
                            ) : null}
                          </span>
                        )}
                      </div>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 800, fontSize: '0.88rem', color: '#ffffff' }}>{token.symbol}</span>
                          {token.address && (
                            <span className="contract-tag">{formatTruncatedAddress(token.address)}</span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {token.name}
                        </div>
                      </div>

                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {disabled ? (
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontWeight: 600 }}>ON OTHER SIDE</span>
                        ) : (
                          <>
                            <div className="font-mono" style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff' }}>
                              {token.usd > 0
                                ? `$${token.usd >= 1 ? token.usd.toLocaleString('en-US', { maximumFractionDigits: 2 }) : token.usd.toPrecision(4)}`
                                : '—'}
                            </div>
                            {token.change24h !== null && token.change24h !== undefined && (
                              <span className={token.change24h >= 0 ? 'change-badge-green' : 'change-badge-red'}>
                                {token.change24h > 0 ? '+' : ''}{token.change24h.toFixed(2)}%
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {/* Main Grid Layout: 2 Columns */}
      <div className="main-grid">
        
        {/* LEFT COLUMN: Sparkline Chart + AI Signal & Swap Card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }}>
          
          {/* Top Minimalist Sparkline SVG Chart */}
          <div className="glass-panel" style={{ padding: '20px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.5px' }}>
                  {selectedPair === 'ALL'
                    ? 'REAL-TIME MONITOR'
                    : `REAL-TIME MONITOR · ${selectedPair}`}
                </div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.5px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {(liveUsdPrices[pairBase] && liveUsdPrices[pairQuote] && liveUsdPrices[pairQuote] > 0)
                    ? `$${fmtPrice(liveUsdPrices[pairBase] / liveUsdPrices[pairQuote])}`
                    : livePrices[`${pairBase}/${pairQuote}`]
                    ? `$${fmtPrice(livePrices[`${pairBase}/${pairQuote}`])}`
                    : '—'}
                  {priceSource !== 'synthetic' && (
                    <span title={priceSource === 'pool' ? 'Live price read from the Uniswap v4 pool (slot0) via your RPC' : 'Market ratio from CoinGecko (no usable v4 pool for this pair)'} style={{
                      fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.5px', padding: '3px 7px', borderRadius: '999px',
                      background: priceSource === 'pool' ? 'rgba(56, 239, 125, 0.12)' : 'rgba(168, 85, 247, 0.12)',
                      border: `1px solid ${priceSource === 'pool' ? 'rgba(56, 239, 125, 0.4)' : 'rgba(168, 85, 247, 0.4)'}`,
                      color: priceSource === 'pool' ? '#38ef7d' : 'var(--accent-violet)'
                    }}>
                      {priceSource === 'pool' ? '◉ LIVE POOL' : '◈ MARKET'}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {(() => {
                  const chg = fmtChange(getUsdChange24h(pairBase));
                  return <div style={{ color: chg.color, fontWeight: 600 }}>{chg.text}</div>;
                })()}
                <div style={{ fontSize: '0.7rem', marginTop: '3px', color: 'var(--text-dim)' }}>
                  Gas: {latestEvent?.trigger.gas_price_gwei ? latestEvent.trigger.gas_price_gwei.toFixed(1) : '27.1'} Gwei
                </div>
              </div>
            </div>

            {/* SVG Sparkline Curve */}
            <div style={{ height: '120px', width: '100%', marginTop: '10px' }}>
              <svg viewBox="0 0 400 70" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                <defs>
                  <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a855f7" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                <path
                  d="M 0 50 Q 40 45, 80 48 T 160 30 T 240 38 T 320 18 T 380 12 L 400 25 L 400 70 L 0 70 Z"
                  fill="url(#sparkline-gradient)"
                />
                <path
                  d="M 0 50 Q 40 45, 80 48 T 160 30 T 240 38 T 320 18 T 380 12 L 400 25"
                  fill="none"
                  stroke="#a855f7"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <circle cx="380" cy="12" r="4" fill="#d946ef" style={{ filter: 'drop-shadow(0 0 6px #d946ef)' }} />
              </svg>
            </div>
          </div>

          {/* AI Signal Card */}
          <div className="glass-panel" style={{ padding: '20px', position: 'relative', overflow: 'hidden' }}>
            {/* Signal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.5px' }}>
                <Activity size={16} style={{ color: 'var(--accent-violet)' }} />
                <span>AI SIGNAL</span>
              </div>
              {latestEvent && signalIsCurrent && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                  Block #{latestEvent.trigger.block_number}
                </span>
              )}
            </div>

            {/* DEX-style Pair Selector: [Base Token ▾] ⇅ [Quote Token ▾] */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '20px' }}>
              {/* Base Token Button */}
              <button
                className="dex-token-btn"
                onClick={() => openTokenPicker('base')}
                title={`Base token: ${pairBase} — click to change`}
              >
                {(() => { const t = tokenBySymbol(pairBase); return <TokenAvatar symbol={t?.symbol ?? pairBase} size={28} color={t && 'color' in t ? t.color : undefined} />; })()}
                <span className="dex-token-label">{pairBase}</span>
                <ChevronDown size={14} style={{ color: 'var(--text-dim)' }} />
              </button>

              {/* Swap / Flip Pair Button */}
              <button
                className="dex-swap-btn"
                onClick={handleSwapPair}
                title="Swap base ↔ quote"
              >
                <RefreshCw size={15} />
              </button>

              {/* Quote Token Button */}
              <button
                className="dex-token-btn"
                onClick={() => openTokenPicker('quote')}
                title={`Quote token: ${pairQuote} — click to change`}
              >
                {(() => { const t = tokenBySymbol(pairQuote); return <TokenAvatar symbol={t?.symbol ?? pairQuote} size={28} color={t && 'color' in t ? t.color : undefined} />; })()}
                <span className="dex-token-label">{pairQuote}</span>
                <ChevronDown size={14} style={{ color: 'var(--text-dim)' }} />
              </button>
            </div>

            {/* Action Badge + Live Price */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px', marginBottom: '18px' }}>
              <span
                style={{
                  fontSize: '1.8rem', fontWeight: 900, letterSpacing: '-0.5px',
                  color: (signalIsCurrent && latestEvent ? latestEvent.decision.action : 'HOLD') === 'BUY'
                    ? 'var(--accent-green)'
                    : (signalIsCurrent && latestEvent ? latestEvent.decision.action : 'HOLD') === 'SELL'
                    ? 'var(--accent-magenta)'
                    : 'var(--accent-amber)'
                }}
              >
                {latestEvent?.decision.action || 'HOLD'}
              </span>
              <span style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)', fontFamily: 'var(--font-mono)' }}>
                {(liveUsdPrices[pairBase] && liveUsdPrices[pairQuote] && liveUsdPrices[pairQuote] > 0)
                  ? `$${fmtPrice(liveUsdPrices[pairBase] / liveUsdPrices[pairQuote])}`
                  : livePrices[`${pairBase}/${pairQuote}`]
                  ? `$${fmtPrice(livePrices[`${pairBase}/${pairQuote}`])}`
                  : '—'}
              </span>
            </div>

            {/* Model Confidence Bar */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600 }}>
                <span>Confidence</span>
                <span style={{ color: '#ffffff', fontWeight: 700 }}>
                  {latestEvent && signalIsCurrent ? `${(latestEvent.decision.confidence * 100).toFixed(0)}%` : '91%'}
                </span>
              </div>
              <div className="confidence-bar-bg">
                <div
                  className="confidence-bar-fill"
                  style={{ width: latestEvent && signalIsCurrent ? `${(latestEvent.decision.confidence * 100).toFixed(0)}%` : '91%' }}
                />
              </div>
            </div>

            {/* AI Reasoning Padded Quote Box */}
            <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', borderRadius: '10px', fontSize: '0.88rem', lineHeight: '1.5', color: 'var(--text-main)', marginBottom: '22px' }}>
              {(latestEvent && signalIsCurrent ? latestEvent.decision.reasoning : '') || `Sell pressure identified at block #${liveBlockNumber || '19845092'}. Performing automatic risk rebalancing to protect capital.`}
            </div>

            {/* Primary Action Button: Confirm Swap — only shown on BUY/SELL */}
            {latestEvent && signalIsCurrent && (latestEvent.decision.action === 'BUY' || latestEvent.decision.action === 'SELL') ? (
              <>
                <button
                  className={`swap-btn ${txStatus === 'pending' ? 'pending' : ''}`}
                  onClick={() => handleExecuteUniswapSwap(latestEvent.decision)}
                  disabled={txStatus === 'pending'}
                >
                  {txStatus === 'pending' ? (
                    <>
                      <div className="btn-spinner" />
                      {txStep === 'approve' ? 'Approving Permit2...' : 'Confirm Swap in Wallet...'}
                    </>
                  ) : (
                    <span>Confirm Swap · {latestEvent.decision.action === 'BUY' ? `Buy ${pairBase}` : `Sell ${pairBase}`}</span>
                  )}
                </button>
                {/* Signal lock notice: shown while a wallet tx is in flight —
                    the card is frozen until the tx is confirmed or rejected. */}
                {isSwapInFlight && (
                  <div style={{
                    marginTop: '10px', padding: '10px 14px', borderRadius: '10px',
                    background: 'rgba(168, 85, 247, 0.10)', border: '1px solid rgba(168, 85, 247, 0.35)',
                    color: 'var(--accent-violet)', fontSize: '0.78rem', fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: '8px'
                  }}>
                    <Clock size={14} />
                    <span>
                      Transaction in flight — signal locked. New AI signals are queued in the feed until this swap is confirmed or rejected in your wallet.
                    </span>
                  </div>
                )}
                {skippedSignalCount > 0 && !isSwapInFlight && (
                  <div style={{
                    marginTop: '10px', padding: '10px 14px', borderRadius: '10px',
                    background: 'rgba(255, 255, 255, 0.03)', border: '1px dashed rgba(255,255,255,0.15)',
                    color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 600,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px'
                  }}>
                    <span>
                      {skippedSignalCount} newer signal{skippedSignalCount > 1 ? 's' : ''} arrived during the last transaction — check the feed.
                    </span>
                    <button
                      onClick={() => setSkippedSignalCount(0)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent-violet)', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{
                padding: '10px 20px', borderRadius: '12px', textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.03)', border: '1px dashed rgba(255,255,255,0.10)',
                color: 'var(--text-dim)', fontSize: '0.88rem', fontWeight: 600
              }}>
                {!latestEvent || !signalIsCurrent
                  ? '⏳ Waiting for AI signal…'
                  : latestEvent.decision.action === 'HOLD'
                  ? '⏸ HOLD — No swap recommended'
                  : '⏳ Waiting for AI signal…'}
              </div>
            )}

            {/* Route Info & Calldata expander — hidden while the displayed
                signal belongs to a pair other than the one on screen (the
                route summary names the SIGNAL's pair, not the picker's). */}
            {latestEvent && signalIsCurrent && latestEvent.decision.uniswap_swap_data && (
              <div style={{ marginTop: '10px' }}>
                <div className="swap-route-info" style={{ fontSize: '0.78rem' }}>
                  Route: <strong>{latestEvent.decision.uniswap_swap_data.route_summary.replace(/\s*\((?:UNICHAIN-SEPOLIA|UNICHAIN|ETHEREUM|ARBITRUM|BASE|POLYGON|SEPOLIA)\)/i, '')}</strong>
                  {/* Client-side execution network (from the pair picker's
                      tab) rendered NEXT to the server-built route summary —
                      the picker decision is always visible even if a stale
                      server binary still labels the summary wrong. */}
                  {(() => {
                    const execChainId = pairChainKey ? chainIdForNetworkKey(pairChainKey) : undefined;
                    return execChainId !== undefined ? (
                      <span style={{ color: 'var(--text-dim)' }}> · exec on {pickerNetworkLabel(execChainId)}</span>
                    ) : null;
                  })()}
                </div>

              </div>
            )}

            {/* Banners */}
            {txStatus === 'success' && activeTxHash && (
              <div className="tx-banner tx-banner-success" style={{ marginTop: '12px' }}>
                <CheckCircle2 size={16} />
                <span>Transaction sent!</span>
                <a href={explorerTxUrl(wagmiChainIdNum, activeTxHash)} target="_blank" rel="noopener noreferrer">Explorer ↗</a>
              </div>
            )}
            {txStatus === 'error' && (
              <div className="tx-banner tx-banner-error" style={{ marginTop: '12px' }}>
                <XCircle size={16} />
                <span>Transaction rejected or failed.</span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Dedicated Real-Time Block & Analysis Feed */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="glass-panel" style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column', minHeight: '620px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <TerminalIcon size={18} style={{ color: 'var(--accent-violet)' }} />
                <h2 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Real-Time Block & Analysis Feed</h2>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                Live Stream
              </span>
            </div>

            <div style={{ flex: 1, background: '#09090b', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '580px' }}>
              {logs.length > 0 ? (
                logs.map((log) => (
                  <div key={log.id} className="font-mono" style={{ fontSize: '0.78rem', padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', borderLeft: `3px solid ${log.decision.action === 'BUY' ? 'var(--accent-green)' : log.decision.action === 'SELL' ? 'var(--accent-magenta)' : 'var(--accent-amber)'}` }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                      [{log.receivedAt}] Block #{log.trigger.block_number} <strong style={{ color: log.decision.action === 'BUY' ? 'var(--accent-green)' : log.decision.action === 'SELL' ? 'var(--accent-magenta)' : 'var(--accent-amber)' }}>{log.decision.action}</strong>
                    </div>
                    <div style={{ marginTop: '2px', color: '#fff' }}>
                      Price: ${fmtPrice(log.trigger.current_price)} | Gas: {log.trigger.gas_price_gwei.toFixed(1)}Gwei
                    </div>
                    <div style={{ color: 'var(--accent-violet)', marginTop: '2px', fontSize: '0.72rem' }}>
                      {log.trigger.pair} Conf: {(log.decision.confidence * 100).toFixed(0)}%
                    </div>
                  </div>
                ))
              ) : (
                // Fallback demo feed entries matching reference mock
                [
                  { id: '1', block: 19845092, action: 'SELL', price: 67468.9, gas: 27.1, conf: 91, pair: 'WBTC/USDC', time: '10:43:49' },
                  { id: '2', block: 19845091, action: 'SELL', price: 67468.9, gas: 27.1, conf: 91, pair: 'WBTC/USDC', time: '10:43:49' },
                  { id: '3', block: 19845093, action: 'SELL', price: 67468.9, gas: 27.5, conf: 91, pair: 'WBTC/USDC', time: '10:43:49' },
                ].map((m) => (
                  <div key={m.id} className="font-mono" style={{ fontSize: '0.78rem', padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', borderLeft: '3px solid var(--accent-magenta)' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                      [{m.time}] Block #{m.block} <strong style={{ color: 'var(--accent-magenta)' }}>{m.action}</strong>
                    </div>
                    <div style={{ marginTop: '2px', color: '#fff' }}>
                      Price: ${fmtPrice(m.price)} | Gas: {m.gas}Gwei
                    </div>
                    <div style={{ color: 'var(--accent-violet)', marginTop: '2px', fontSize: '0.72rem' }}>
                      {m.pair} Conf: {m.conf}%
                    </div>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <WalletProviders>
      <AppContent />
    </WalletProviders>
  );
}