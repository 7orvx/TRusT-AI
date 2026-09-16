// Network metadata (presentation-only) for the TRusT-AI dashboard.
//
// The header network dropdown was REMOVED: the execution network is derived
// from the monitored pair (see apps/web/src/pairNetworks.ts and the unified
// pair picker in App.tsx). This module keeps the chain badge/logo/color data
// used by the token picker overlays and the wallet status displays.
//
// Re-exports of SUPPORTED_CHAINS / CHAIN_NAMES keep the existing import sites
// (config.ts consumers) stable while the old dropdown is retired.

import { SUPPORTED_CHAINS as CONFIG_SUPPORTED_CHAINS, CHAIN_NAMES as CONFIG_CHAIN_NAMES } from './config';

export { SUPPORTED_CHAINS, CHAIN_NAMES } from './config';
export const SUPPORTED_CHAIN_IDS = CONFIG_SUPPORTED_CHAINS.map((c) => c.id);

// Chain ID → display color (mirrors the dashboard's accent palette).
export const CHAIN_COLORS: Record<number, string> = {
  11155111: '#9d4edd', // Sepolia — purple
  1: '#38ef7d',        // Ethereum Mainnet — green
  42161: '#f5a524',    // Arbitrum — orange
  8453: '#00d4aa',     // Base — teal
  137: '#8247e0',      // Polygon — indigo
  130: '#ff3366',      // Unichain mainnet — pink
  1301: '#ff3366',     // Unichain Sepolia — pink/red
};

// Official network logos (TrustWallet assets CDN). Purely PRESENTATION data —
// never used as swap/pair identifiers (those stay in the shared token
// catalogs mirrored with the Rust engine and the server).
export const CHAIN_LOGOS: Record<number, string> = {
  1: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  42161: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png',
  8453: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png',
  137: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png',
  // No official Unichain asset exists yet — the badge falls back to the brand
  // color + letter for 130, 1301 and 11155111.
};

// Presentation-only badge info for the token picker overlays: brand color,
// display label and a 1-2 char monogram (shown when no logo URL exists).
export function getNetworkBadgeInfo(chainId: number): { label: string; color: string; symbol: string; logo?: string } {
  switch (chainId) {
    case 1:
      return { label: 'Ethereum', color: '#627eea', symbol: 'Ξ', logo: CHAIN_LOGOS[1] };
    case 42161:
      return { label: 'Arbitrum', color: '#28a0f0', symbol: 'AR', logo: CHAIN_LOGOS[42161] };
    case 8453:
      return { label: 'Base', color: '#0052ff', symbol: 'B', logo: CHAIN_LOGOS[8453] };
    case 137:
      return { label: 'Polygon', color: '#8247e0', symbol: 'P', logo: CHAIN_LOGOS[137] };
    case 130:
      return { label: 'Unichain', color: '#ff3366', symbol: 'U' };
    case 1301:
      return { label: 'Unichain Sepolia', color: '#ff3366', symbol: 'U' };
    case 11155111:
    default:
      return { label: 'Sepolia', color: '#9d4edd', symbol: 'S' };
  }
}
