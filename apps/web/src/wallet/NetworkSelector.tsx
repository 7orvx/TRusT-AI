// Network selector dropdown for the TRusT-AI dashboard header.
//
// Lets the user switch between supported EVM chains:
//   - Sepolia (testnet, default)
//   - Ethereum Mainnet
//   - Arbitrum One
//   - Base
//   - Polygon PoS
//   - Unichain Sepolia (testnet playground for mock USDT/USDC swaps)
//
// Uses Wagmi's useSwitchChain hook to update the active chain on the wallet
// connector AND the frontend RPC URL (so data fetches always match the
// selected chain).
//
// The selected chain is reflected in the header pill and in all on-chain reads
// (prices, balances, block number) via the priceFetcher module.

import React, { useState, useEffect } from 'react';
import { ChevronDown, Globe, Check } from 'lucide-react';
import { useActiveChainId, useSwitchChainHook, SUPPORTED_CHAINS, CHAIN_NAMES } from './config';

// Chain ID → display color (mirrors the dashboard's accent palette).
const CHAIN_COLORS: Record<number, string> = {
  11155111: '#9d4edd', // Sepolia — purple
  1: '#38ef7d',        // Ethereum Mainnet — green
  42161: '#f5a524',    // Arbitrum — orange
  8453: '#00d4aa',     // Base — teal
  137: '#8247e0',      // Polygon — indigo
  1301: '#ff3366',     // Unichain Sepolia — pink/red
};

export type NetworkSelectorProps = {
  /** Whether the selector is currently open. */
  open: boolean;
  /** Callback to toggle the open state. */
  onToggle: () => void;
  /** Whether to close the dropdown after a chain is selected. */
  autoClose?: boolean;
  /** Optional callback when a chain is selected. */
  onSelectChain?: (chainId: number) => void;
};

const SUPPORTED_CHAIN_IDS = SUPPORTED_CHAINS.map((c) => c.id);

export function NetworkSelector({ open, onToggle, autoClose = true, onSelectChain }: NetworkSelectorProps) {
  const chainId = useActiveChainId();
  const { switchChain } = useSwitchChainHook();
  const [localChainId, setLocalChainId] = useState<number>(() => {
    if (chainId) return chainId;
    const stored = localStorage.getItem('trust_ai_selected_chain');
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && CHAIN_NAMES[parsed]) return parsed;
    }
    return 11155111; // Sepolia default
  });

  // Sync the local state when wagmi's chain changes (e.g. user switched via
  // wallet popup instead of this selector).
  useEffect(() => {
    if (chainId) {
      setLocalChainId(chainId);
    }
  }, [chainId]);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    const modal = document.getElementById('network-selector-menu');
    if (!modal) return;
    const outsideHandler = (e: MouseEvent) => {
      if (!modal.contains(e.target as Node)) {
        onToggle();
      }
    };
    document.addEventListener('mousedown', outsideHandler);
    return () => document.removeEventListener('mousedown', outsideHandler);
  }, [open, onToggle]);

  const handleSelectChain = async (id: number) => {
    setLocalChainId(id);
    localStorage.setItem('trust_ai_selected_chain', id.toString());
    onSelectChain?.(id);

    try {
      if (typeof window !== 'undefined' && (window as any).__APP_KIT_INSTANCE?.switchNetwork) {
        const targetChain = SUPPORTED_CHAINS.find((c) => c.id === id);
        if (targetChain) {
          await (window as any).__APP_KIT_INSTANCE.switchNetwork(targetChain);
        }
      }
      await switchChain({ chainId: id });
    } catch (err) {
      console.warn('Network switch applied locally (wallet prompt optional):', err);
    }

    if (autoClose) onToggle();
  };

  const activeDisplayId = chainId ?? localChainId;
  const currentColor = CHAIN_COLORS[activeDisplayId] ?? '#5c6b7e';
  const currentName = CHAIN_NAMES[activeDisplayId] ?? 'Sepolia';

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger button — shows the current chain with a color dot. */}
      <button
        type="button"
        onClick={onToggle}
        title={`Switch network — currently on ${currentName}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '5px 10px',
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${currentColor}`,
          borderRadius: '999px',
          color: 'var(--text-main)',
          fontWeight: 600,
          fontSize: '0.78rem',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: currentColor,
            boxShadow: `0 0 8px ${currentColor}`,
            flexShrink: 0,
          }}
        />
        <Globe size={13} style={{ color: currentColor }} />
        <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentName}
        </span>
        <ChevronDown
          size={12}
          style={{
            color: 'var(--text-dim)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s ease',
          }}
        />
      </button>

      {/* Dropdown menu — absolutely positioned relative to the container. */}
      {open && (
        <div
          id="network-selector-menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            minWidth: 170,
            background: 'rgba(18, 18, 18, 0.99)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '10px',
            padding: '6px',
            zIndex: 100,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {SUPPORTED_CHAIN_IDS.map((id) => {
            const name = CHAIN_NAMES[id] ?? 'Unknown';
            const color = CHAIN_COLORS[id] ?? '#5c6b7e';
            const isActive = activeDisplayId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleSelectChain(id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '8px 10px',
                  background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: 'none',
                  borderRadius: '6px',
                  color: isActive ? color : 'var(--text-main)',
                  fontWeight: isActive ? 700 : 400,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.15s ease',
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: color,
                    boxShadow: isActive ? `0 0 8px ${color}` : 'none',
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>{name}</span>
                {isActive && (
                  <Check size={14} style={{ color, flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
