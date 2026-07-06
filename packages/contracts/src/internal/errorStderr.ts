/**
 * Shared cap for the raw stderr retained on process-exit error classes
 * (`GitCommandError`, `VcsProcessExitError`). Bounds memory held by
 * long-lived error values while keeping the classification-relevant head of
 * the output (branch-protection / non-fast-forward text appears early).
 *
 * The capped value is stored OFF the error schemas (a private field behind a
 * getter) so it stays server-side only — see the `stderr` getters on those
 * classes for the redaction rationale.
 */
export const ERROR_STDERR_MAX_CHARS = 8_192;

export const capErrorStderr = (stderr: string): string =>
  stderr.length > ERROR_STDERR_MAX_CHARS ? stderr.slice(0, ERROR_STDERR_MAX_CHARS) : stderr;
