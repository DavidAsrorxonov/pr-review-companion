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
    else setError(reply.error);
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { sequence.current++; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  return { status, error, refresh };
}
