import { AuthFailure, safeError } from '../auth/errors';
import type { ReviewError, ReviewErrorCode } from '../../shared/reviews';

export class ReviewFailure extends Error {
  constructor(readonly code: ReviewErrorCode) { super(code); }
}
export function safeReviewError(error: unknown): ReviewError {
  if (error instanceof ReviewFailure) return { code: error.code };
  if (error instanceof AuthFailure) return safeError(error);
  return { code: 'UNEXPECTED_RESPONSE' };
}
