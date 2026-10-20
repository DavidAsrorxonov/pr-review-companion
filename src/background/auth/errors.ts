import type { AuthError, AuthErrorCode } from '../../shared/auth';

export class AuthFailure extends Error {
  constructor(readonly code: AuthErrorCode, readonly retryAt?: number) {
    super(code);
  }
}

export function safeError(error: unknown): AuthError {
  if (!(error instanceof AuthFailure)) return { code: 'UNEXPECTED_RESPONSE' };
  return error.retryAt === undefined ? { code: error.code } : { code: error.code, retryAt: error.retryAt };
}
