/** Errors the API maps to HTTP statuses. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const notFound = (what: string) => new DomainError(404, 'not_found', `${what} not found`);
export const forbidden = (msg: string) => new DomainError(403, 'forbidden', msg);
export const conflict = (msg: string, details?: unknown) => new DomainError(409, 'conflict', msg, details);
export const invalid = (msg: string, details?: unknown) => new DomainError(422, 'invalid', msg, details);

/** The edit-after-approval defense (design guide §8.3). */
export class ApprovalInvalidatedError extends DomainError {
  constructor(
    readonly reapprovers: string[],
    message: string,
  ) {
    super(409, 'approval_invalidated', message, { reapprovers });
    this.name = 'ApprovalInvalidatedError';
  }
}

export interface Clock {
  now(): string;
}
export const systemClock: Clock = { now: () => new Date().toISOString() };

/** Deterministic clock for tests and demos. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: string) {
    this.t = Date.parse(start);
  }
  now(): string {
    return new Date(this.t).toISOString();
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
  advanceMinutes(m: number): void {
    this.t += m * 60_000;
  }
  advanceHours(h: number): void {
    this.advanceMinutes(h * 60);
  }
}
