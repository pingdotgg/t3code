/**
 * The reason a placeholder Durable Object aborts every call with (see
 * `makePlaceholderScript` in `WorkerProvider.ts`). The abort resets the
 * object, so the next call constructs it from the currently deployed code.
 *
 * @internal
 */
export const placeholderResetReason = "Alchemy worker is being deployed";

/**
 * Whether a failed RPC call was answered by a placeholder Durable Object. It
 * ran none of the real code, so the call is always safe to retry.
 *
 * @internal
 */
export const isPlaceholderReset = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.includes(placeholderResetReason);
