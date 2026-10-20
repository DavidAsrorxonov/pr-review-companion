import { errorMessages } from './auth';
import type { AuthError } from './auth';

export function AuthErrorMessage({ error }: { error: AuthError }) {
  return (
    <p role="alert" className="mt-3 text-sm leading-relaxed text-red-700">
      {errorMessages[error.code]}
      {error.retryAt !== undefined && <> Retry after {new Date(error.retryAt).toLocaleString()}.</>}
    </p>
  );
}
