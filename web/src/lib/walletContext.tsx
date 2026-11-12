import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Address } from 'viem';
import {
  burnerHandle,
  getOrCreateBurner,
  getProviders,
  importBurnerKey,
  injectedHandle,
  loadBurner,
  markBurnerBackedUp,
  requestAccounts,
  silentAccounts,
  startWalletDiscovery,
  subscribeProviders,
  type BurnerInfo,
  type InjectedDetail,
  type WalletHandle,
} from './wallet';

const MODE_KEY = 'hongbao.walletMode.v1';

interface Pref {
  kind: 'burner' | 'injected';
  rdns?: string;
}

function readPref(): Pref {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Pref;
      if (o.kind === 'burner' || o.kind === 'injected') return o;
    }
  } catch {
    /* ignore */
  }
  return { kind: 'burner' };
}

function writePref(p: Pref) {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

interface InjectedState {
  detail: InjectedDetail;
  address: Address;
}

export interface WalletContextValue {
  /** The wallet pages act with, or null when there is none yet. */
  active: WalletHandle | null;
  burner: BurnerInfo | null;
  injected: InjectedState | null;
  providers: InjectedDetail[];
  /** Connect an injected wallet and make it active. */
  connect(detail: InjectedDetail): Promise<void>;
  /** Make the phone wallet active, creating it if needed. */
  selectBurner(): WalletHandle;
  disconnect(): void;
  importKey(key: string): void;
  markBackedUp(): void;
}

const Ctx = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const providers = useSyncExternalStore(subscribeProviders, getProviders, getProviders);
  const [burner, setBurner] = useState<BurnerInfo | null>(() => {
    try {
      return loadBurner();
    } catch {
      return null;
    }
  });
  const [pref, setPref] = useState<Pref>(readPref);
  const [injected, setInjected] = useState<InjectedState | null>(null);

  useEffect(() => {
    startWalletDiscovery();
  }, []);

  // Restore a previously connected injected wallet without prompting.
  useEffect(() => {
    if (pref.kind !== 'injected' || injected || !providers.length) return;
    const detail = providers.find((p) => p.info.rdns === pref.rdns) ?? providers[0];
    let cancelled = false;
    void silentAccounts(detail.provider).then((address) => {
      if (!cancelled && address) setInjected({ detail, address });
    });
    return () => {
      cancelled = true;
    };
  }, [pref, injected, providers]);

  // Follow account switches inside the wallet.
  useEffect(() => {
    if (!injected) return;
    const p = injected.detail.provider;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      if (!list?.length) setInjected(null);
      else setInjected((cur) => (cur ? { ...cur, address: list[0] as Address } : cur));
    };
    p.on?.('accountsChanged', onAccounts);
    return () => {
      p.removeListener?.('accountsChanged', onAccounts);
    };
  }, [injected]);

  // Keep tabs in sync when the phone wallet changes elsewhere.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'hongbao.wallet.v1') setBurner(loadBurner());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const connect = useCallback(async (detail: InjectedDetail) => {
    const address = await requestAccounts(detail.provider);
    setInjected({ detail, address });
    const p: Pref = { kind: 'injected', rdns: detail.info.rdns };
    setPref(p);
    writePref(p);
  }, []);

  const selectBurner = useCallback((): WalletHandle => {
    const b = getOrCreateBurner();
    setBurner(b);
    const p: Pref = { kind: 'burner' };
    setPref(p);
    writePref(p);
    return burnerHandle(b.address);
  }, []);

  const disconnect = useCallback(() => {
    setInjected(null);
    const p: Pref = { kind: 'burner' };
    setPref(p);
    writePref(p);
  }, []);

  const importKey = useCallback((key: string) => {
    const b = importBurnerKey(key);
    setBurner(b);
    const p: Pref = { kind: 'burner' };
    setPref(p);
    writePref(p);
  }, []);

  const markBackedUp = useCallback(() => {
    markBurnerBackedUp();
    setBurner(loadBurner());
  }, []);

  const active = useMemo<WalletHandle | null>(() => {
    if (pref.kind === 'injected' && injected) return injectedHandle(injected.detail, injected.address);
    if (burner) return burnerHandle(burner.address);
    return null;
  }, [pref.kind, injected, burner]);

  const value = useMemo<WalletContextValue>(
    () => ({ active, burner, injected, providers, connect, selectBurner, disconnect, importKey, markBackedUp }),
    [active, burner, injected, providers, connect, selectBurner, disconnect, importKey, markBackedUp],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
