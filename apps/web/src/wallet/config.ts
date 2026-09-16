// WalletConnect / Reown AppKit + Wagmi configuration for the TRusT-AI web dashboard.
//
// Architecture (single source of truth):
//   - The Wagmi config is created through the official Reown `WagmiAdapter`
//     (@reown/appkit-adapter-wagmi). The AppKit modal and the Wagmi hooks
//     (useAccount / useConnect / useSwitchChain ...) then share ONE store:
//     connecting in the AppKit modal (WalletConnect QR / mobile wallets) or via
//     an injected extension (MetaMask/Rabby) both update the same React state,
//     so the header pill and the network selector always stay in sync.
//   - This requires the wagmi 2.x line: Reown AppKit only supports wagmi 2.x
//     (see https://docs.reown.com/appkit). Do not bump wagmi to 3.x without
//     checking Reown adapter compatibility first.
//
// Project ID handling:
//   - Prefer VITE_WALLETCONNECT_PROJECT_ID from the Vite env (dev/build-time).
//   - If absent, fall back to a hardcoded constant so the bundled desktop .exe
//     runs without anyone having to manually set up a .env before opening it.
//
// Alchemy API key handling:
//   - Prefer VITE_ALCHEMY_API_KEY from the Vite env (dev/build-time).
//   - If absent, fall back to a hardcoded constant so the bundled desktop .exe
//     can fetch on-chain data without manual env setup.
//
// The WalletConnect Project ID is a PUBLIC identifier (not a secret): it only
// tells the WalletConnect relay which app is requesting a connection. It does
// not grant signing, fund access, or data-read permissions. See docs/SECURITY.md
// and the WalletConnect/Reown dashboard for origin/domain allowlist options.
//
// Alchemy API keys can be restricted by domain in the Alchemy dashboard
// (Settings → Security). They are not secrets like private keys, but treat
// them with reasonable care.

import { mainnet, arbitrum, base, polygon, sepolia, unichainSepolia } from 'viem/chains';
import { http } from 'viem';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createAppKit } from '@reown/appkit/react';
import { injected } from 'wagmi/connectors';
import { getAccount, watchAccount } from 'wagmi/actions';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useEnsName,
  useEnsAvatar,
  useSwitchChain,
} from 'wagmi';

// ---------------------------------------------------------------------------
// Project metadata shown inside the WalletConnect connection modal.
// ---------------------------------------------------------------------------
export const APP_META = {
  name: 'TRusT-AI',
  description: 'Autonomous DeFi trading-agent dashboard with 1-click Uniswap v4 execution',
  url: 'http://localhost:5173',
  icons: [typeof window !== 'undefined' ? `${window.location.origin}/appicon.png` : 'http://localhost:5173/appicon.png'],
};

// ---------------------------------------------------------------------------
// Supported EVM chains.
// Sepolia is the primary active network for the current testnet/simulator flow;
// Ethereum Mainnet, Arbitrum, Base and Polygon are registered so they are
// available for production use without a further config change.
// ---------------------------------------------------------------------------
export const SUPPORTED_CHAINS = [
  sepolia, // active default (current testnet / simulator labels)
  mainnet, // Ethereum Mainnet
  arbitrum, // Arbitrum One
  base, // Base
  polygon, // Polygon PoS
  unichainSepolia, // Unichain Sepolia — testnet playground for mock USDT/USDC
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

// Chain ID → human-readable name (for UI display).
export const CHAIN_NAMES: Record<number, string> = {
  [sepolia.id]: 'Sepolia',
  [mainnet.id]: 'Ethereum',
  [arbitrum.id]: 'Arbitrum',
  [base.id]: 'Base',
  [polygon.id]: 'Polygon',
  [unichainSepolia.id]: 'Unichain Sepolia',
};

// ---------------------------------------------------------------------------
// WalletConnect Project ID.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROJECT_ID_FROM_ENV = (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID ?? '';

// Hardcoded fallback so the packaged desktop app does not break when no .env
// is supplied at build time. Replace this constant if a different Project ID
// is preferred (it is safe to commit: see file header).
const PROJECT_ID_FALLBACK = 'b01fc9a889c7da0e31bbd1d17aafca1f';

export const WALLETCONNECT_PROJECT_ID =
  PROJECT_ID_FROM_ENV || PROJECT_ID_FALLBACK;

// ---------------------------------------------------------------------------
// Alchemy API key (for RPC data fetching when configured).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALCHEMY_KEY_FROM_ENV = (import.meta as any).env?.VITE_ALCHEMY_API_KEY ?? '';

// Hardcoded fallback so the packaged desktop .exe can fetch on-chain data
// without manual env setup. Replace if a different key is preferred.
// NOTE: Alchemy API keys can be restricted by domain in the Alchemy dashboard
// — see docs/SECURITY.md. They are NOT secrets like private keys, but treat
// them with reasonable care (don't paste them in public chats).
const ALCHEMY_KEY_FALLBACK = 'alch_1putSHNWM5T5cGU_cCMa3';

export const ALCHEMY_API_KEY =
  ALCHEMY_KEY_FROM_ENV || ALCHEMY_KEY_FALLBACK;

/** Returns the RPC URL for a given chain ID (Alchemy when configured, public fallback otherwise). */
export function getRpcUrlForChain(chainId: number): string {
  // When an Alchemy key is configured (and it's not the default fallback),
  // use Alchemy's endpoints (more reliable rate limits + analytics).
  const useAlchemy = ALCHEMY_API_KEY && ALCHEMY_API_KEY !== ALCHEMY_KEY_FALLBACK;

  if (useAlchemy) {
    if (chainId === 11155111) return `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    if (chainId === 1) return `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    if (chainId === 42161) return `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    if (chainId === 8453) return `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    if (chainId === 137) return `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    if (chainId === 1301) return `https://unichain-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  }

  // Free public RPC endpoints for the supported chains.
  if (chainId === 11155111) return 'https://rpc.sepolia.org';
  if (chainId === 1) return 'https://eth.llamarpc.com';
  if (chainId === 42161) return 'https://arb1.arbitrum.io/rpc';
  if (chainId === 8453) return 'https://mainnet.base.org';
  if (chainId === 137) return 'https://polygon-rpc.com';
  if (chainId === 1301) return 'https://sepolia.unichain.org';
  return 'https://rpc.ankr.com';
}

// ---------------------------------------------------------------------------
// Wagmi adapter + AppKit — ONE shared store.
//
// The Reown WagmiAdapter builds the wagmi config (wagmiConfig) AND registers
// itself with AppKit, so connections made inside the AppKit modal (WalletConnect
// QR / mobile / injected) are written into the same wagmi store that the React
// hooks below read. The header "Connect Wallet" pill, the network selector and
// the swap execution path therefore always reflect the real session.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const wagmiAdapter = new WagmiAdapter({
  projectId: WALLETCONNECT_PROJECT_ID,
  networks: SUPPORTED_CHAINS as any,
  transports: Object.fromEntries(
    SUPPORTED_CHAINS.map((chain) => [
      chain.id,
      http(getRpcUrlForChain(chain.id))
    ])
  ) as any,
  // Deterministic injected connector so the browser-extension path always has
  // a connector to connect through (EIP-6963 discovery alone may lag).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectors: [injected()] as any,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  projectId: WALLETCONNECT_PROJECT_ID,
  networks: SUPPORTED_CHAINS as any,
  metadata: APP_META,
  // Sepolia is the default testnet for the simulator flow.
  defaultNetwork: sepolia,
});

// Expose the shared AppKit instance on window to keep the legacy UI entry
// points (Connect Wallet button + any direct modal-open calls) working even
// when the React code is structurally split across components.
if (typeof window !== 'undefined') {
  (window as any).__APP_KIT_INSTANCE = appKit;
}
// ---------------------------------------------------------------------------
// Public helpers consumed by the React UI layer.
// ---------------------------------------------------------------------------

/** Active account state (address/chainId/isConnected) — driven by the shared wagmi/AppKit store. */
export const useActiveAccount = () => useAccount();

/** Active ENS name (best-effort), null when unavailable. */
export const useActiveEnsName = () => useEnsName();

/** Active ENS avatar (best-effort), null when unavailable. */
export const useActiveEnsAvatar = () => useEnsAvatar();

/** WalletConnect / Wagmi connection hook. */
export const useWalletConnect = () => useConnect();

/** Disconnect hook. */
export const useWalletDisconnect = () => useDisconnect();

/** Hook to switch the active chain (for the network selector). */
export const useSwitchChainHook = () => useSwitchChain();

/** Active chain ID (number when connected, undefined otherwise). */
export const useActiveChainId = () => {
  const { chainId } = useAccount();
  return chainId;
};

/** Returns the shared AppKit instance (opens the WalletConnect modal). */
export const createWalletConnectAppKit = () => appKit;

/**
 * Resolves once a wallet session is registered in the shared store, returning
 * the connected address (or null on timeout). Used right after the AppKit
 * modal closes so the caller can act on the freshly-connected account even
 * though React state may not have re-rendered yet.
 */
export function waitForWalletConnection(timeoutMs = 10000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let unsub: () => void = () => {};
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        resolve(null);
      }
    }, timeoutMs);
    const settle = (address: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(address);
      }
    };
    unsub = watchAccount(wagmiConfig, {
      onChange(data) {
        if (data.isConnected && data.address) settle(data.address);
      },
    });
    const current = getAccount(wagmiConfig);
    if (current.isConnected && current.address) settle(current.address);
  });
}

/**
 * Returns the EIP-1193 provider of the ACTIVE wallet session:
 *   1. the active wagmi connector's provider (covers injected extensions AND
 *      WalletConnect sessions bridged through the Reown adapter), or
 *   2. an injected browser provider (window.ethereum) as a last-resort
 *      fallback for non-wagmi paths.
 * Returns null when no wallet is connected.
 *
 * This is used by the swap execution path so it always talks to the session
 * the user actually approved (instead of blindly using window.ethereum, which
 * has no session in the desktop app where connections go through WalletConnect).
 */
export async function getActiveProvider(): Promise<EIP1193 | null> {
  // 1) Active connector of the shared wagmi/AppKit store.
  try {
    const { connector, isConnected } = getAccount(wagmiConfig);
    if (isConnected && connector) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = await (connector as any).getProvider?.();
      if (provider && typeof provider.request === 'function') {
        return provider as EIP1193;
      }
    }
  } catch {
    // Store not ready / connector without provider — fall through.
  }

  // 2) Injected browser provider fallback (present + unlocked).
  if (typeof window !== 'undefined' && (window as any).ethereum) {
    try {
      const ethereum = (window as any).ethereum as EIP1193;
      // Quick sanity check: ask for the chain id without prompting.
      const chainId = (ethereum as any).request?.({ method: 'eth_chainId' });
      if (typeof chainId === 'string' || typeof chainId === 'number' || chainId instanceof Promise) {
        return ethereum;
      }
    } catch {
      // Injected provider exists but is locked/disconnected — fall through.
    }
  }

  return null;
}

/** Minimal EIP-1193 provider shape consumed by the execution path. */
export interface EIP1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
  send?(request: { method: string; params?: unknown[] }): Promise<unknown>;
}
