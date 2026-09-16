// WalletConnect / Wagmi / React Query provider tree for the TRusT-AI web app.
//
// Rendering this once at the top of the React tree gives every component access
// to useAccount, useConnect, useDisconnect, useEnsName, useEnsAvatar and the
// AppKit instance (for opening the WalletConnect modal).
//
// IMPORTANT: the wagmi config comes from the Reown WagmiAdapter (see
// wallet/config.ts), which bridges the AppKit modal and the wagmi store into a
// SINGLE source of truth. Connections made inside the AppKit modal
// (WalletConnect QR / mobile) and connections via injected browser wallets
// (MetaMask/Rabby) therefore both update the React hooks below — the header
// pill and network selector can never desync from the real wallet session.
//
// Project ID is read from apps/web/src/wallet/config.ts (env-var preference with
// a hardcoded fallback constant for the bundled desktop .exe).

import React from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig, appKit } from './config';

// One QueryClient for the whole React tree (Wagmi uses it internally).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 60 * 5 }
  }
});

export type WalletProvidersProps = { children: React.ReactNode };

export function WalletProviders({ children }: WalletProvidersProps) {
  // Expose the AppKit instance on window so non-React code (and the connect
  // handler in App.tsx) can open the WalletConnect modal when needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(window as any).__APP_KIT_INSTANCE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__APP_KIT_INSTANCE = appKit;
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
