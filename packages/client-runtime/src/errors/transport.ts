const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bis not connected\.$/i,
  /\bdisconnected\.$/i,
  /\bcould not establish a WebSocket connection\.$/i,
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
] as const;

/**
 * Noise emitted by provider SDKs when a turn is aborted mid-flight (e.g. the
 * user presses stop or interrupts to send a new message). These are interrupt
 * artifacts, not real failures, so they should never surface as a thread error
 * banner.
 *
 * - Claude Agent SDK: yields an `error_during_execution` result whose first
 *   error is an `[ede_diagnostic]` line such as:
 *     `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`
 * - OpenCode: emits a bare `Aborted` error message when the active session is
 *   aborted via interrupt.
 */
const INTERRUPT_ARTIFACT_PATTERNS = [
  /\[ede_diagnostic\]/i,
  // OpenCode aborts surface as exactly "Aborted" (optionally prefixed by an
  // error class, e.g. "AbortError: Aborted"). Anchor to the whole message so we
  // don't swallow legitimate errors that merely mention the word "aborted".
  /^(?:[\w.]*error:\s*)?aborted\.?$/i,
] as const;

/**
 * Test whether an error message is an internal diagnostic artifact produced by
 * interrupting a turn, rather than a genuine error worth showing the user.
 */
export function isInterruptArtifactErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return INTERRUPT_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Test whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Strip transport connection errors from user-facing error messages.
 * Returns `null` for transport errors so the UI can distinguish between
 * real errors and transient connection issues.
 */
export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  if (isTransportConnectionErrorMessage(message) || isInterruptArtifactErrorMessage(message)) {
    return null;
  }
  return message ?? null;
}
