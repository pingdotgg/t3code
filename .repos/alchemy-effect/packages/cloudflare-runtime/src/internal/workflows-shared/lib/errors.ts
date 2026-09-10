// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export class WorkflowTimeoutError extends Error {
  name = "WorkflowTimeoutError";
}

export class WorkflowInternalError extends Error {
  name = "WorkflowInternalError";
}

export class WorkflowFatalError extends Error {
  name = "WorkflowFatalError";

  toJSON() {
    return {
      name: this.name,
      message: this.message,
    };
  }
}

export class PreservedNonRetryableError extends WorkflowFatalError {
  name = "NonRetryableError";

  constructor(err: Error) {
    // When the error crosses an RPC boundary, the name gets
    // prepended to the message (e.g. "NonRetryableError: msg",
    // or just "NonRetryableError" if the original message was empty).
    // Parse it back out so we surface the original message.
    const message =
      err.name === "NonRetryableError"
        ? err.message
        : err.message.replace(/^NonRetryableError:?\s*/, "");
    super(message);
  }
}

export class WorkflowError extends Error {
  name = "WorkflowError";
}

export class InvalidStepReadableStreamError extends Error {
  name = "InvalidStepReadableStreamError";
}

export class OversizedStreamChunkError extends Error {
  name = "OversizedStreamChunkError";
}

export class UnsupportedStreamChunkError extends Error {
  name = "UnsupportedStreamChunkError";
}

export class StreamOutputStorageLimitError extends Error {
  name = "StreamOutputStorageLimitError";
}

export function createWorkflowError(message: string, errorCode: string): WorkflowError {
  return new WorkflowError(`(${errorCode}) ${message}`);
}

const ABORT_PREFIX = "Aborting engine:" as const;

export const ABORT_REASONS = {
  USER_PAUSE: `${ABORT_PREFIX} User called pause`,
  USER_RESTART: `${ABORT_PREFIX} User called restart`,
  USER_TERMINATE: `${ABORT_PREFIX} User called terminate`,
  NON_RETRYABLE_ERROR: `${ABORT_PREFIX} A step threw a NonRetryableError`,
  NOT_SERIALISABLE: `${ABORT_PREFIX} Value is not serialisable`,
  STORAGE_LIMIT_EXCEEDED: `${ABORT_PREFIX} Storage limit exceeded`,
  GRACE_PERIOD_COMPLETE: `${ABORT_PREFIX} Grace period complete`,
} as const;

const ABORT_REASON_SET: ReadonlySet<string> = new Set(Object.values(ABORT_REASONS));

function getErrorMessage(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "object" && e !== null) {
    const msg = (e as { message?: string }).message;
    if (typeof msg === "string") {
      return msg;
    }
  }
  return undefined;
}

export function isAbortError(e: unknown): boolean {
  const msg = getErrorMessage(e);
  return msg !== undefined && ABORT_REASON_SET.has(msg);
}

export function isUserTriggeredPause(e: unknown): boolean {
  return getErrorMessage(e) === ABORT_REASONS.USER_PAUSE;
}

export function isUserTriggeredRestart(e: unknown): boolean {
  return getErrorMessage(e) === ABORT_REASONS.USER_RESTART;
}

export function isUserTriggeredTerminate(e: unknown): boolean {
  return getErrorMessage(e) === ABORT_REASONS.USER_TERMINATE;
}

function getCompatFlag(name: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- safe globalThis access for environments where cloudflare global may not exist
  return (globalThis as any).Cloudflare?.compatibilityFlags?.[name] ?? false;
}

export function shouldPreserveNonRetryableError(): boolean {
  return getCompatFlag("workflows_preserve_non_retryable_error_message");
}

export function stepNotFoundError(name: string): WorkflowError {
  return createWorkflowError(
    `Step "${name}" not found in execution history`,
    "instance.cannot_restart",
  );
}
