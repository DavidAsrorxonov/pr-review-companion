import { useCallback, useEffect, useRef, useState } from 'react';
import { requestAuth } from './auth';
import type { AuthError, AuthStatus } from './auth';

export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<AuthError | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    const reply = await requestAuth({ type: 'auth.status' });
    if (current !== sequence.current) return;
    if (reply.ok) { setStatus(reply.status); setError(null); }
    else { setStatus(null); setError(reply.error); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !Object.hasOwn(changes, 'prrc.auth.v1')) return;
      // Never inspect the event's credential values; clear private UI immediately.
      setStatus(null);
      void refresh();
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => { sequence.current++; window.removeEventListener('focus', onFocus); chrome.storage.onChanged.removeListener(onStorage); };
  }, [refresh]);
  return { status, error, refresh };
}
