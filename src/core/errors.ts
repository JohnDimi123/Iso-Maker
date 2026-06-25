/** Typed error hierarchy used across engines for comprehensive error handling. */

export type ErrorCategory =
  | 'io'
  | 'format'
  | 'hardware'
  | 'media'
  | 'verification'
  | 'unsupported'
  | 'cancelled'
  | 'internal';

export class IsoMakerError extends Error {
  readonly category: ErrorCategory;
  /** Whether the operation may succeed if retried (used by retry handler). */
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    message: string,
    opts: { recoverable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'IsoMakerError';
    this.category = category;
    this.recoverable = opts.recoverable ?? false;
    this.details = opts.details;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export const Errors = {
  io: (msg: string, recoverable = true, cause?: unknown) =>
    new IsoMakerError('io', msg, { recoverable, cause }),
  format: (msg: string, cause?: unknown) => new IsoMakerError('format', msg, { cause }),
  hardware: (msg: string, recoverable = false, cause?: unknown) =>
    new IsoMakerError('hardware', msg, { recoverable, cause }),
  media: (msg: string, cause?: unknown) => new IsoMakerError('media', msg, { cause }),
  verification: (msg: string, cause?: unknown) => new IsoMakerError('verification', msg, { cause }),
  unsupported: (msg: string) => new IsoMakerError('unsupported', msg, {}),
  cancelled: (msg = 'Operation cancelled') => new IsoMakerError('cancelled', msg, {}),
  internal: (msg: string, cause?: unknown) => new IsoMakerError('internal', msg, { cause })
};

export function isCancellation(err: unknown): boolean {
  return err instanceof IsoMakerError && err.category === 'cancelled';
}
