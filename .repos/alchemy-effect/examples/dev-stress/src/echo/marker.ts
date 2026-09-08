/**
 * Marker read by `EchoWorker`, whose module the STACK imports
 * (`main: import.meta.url`). Rewriting this file therefore travels the
 * full-restart reload path: `bun --watch` re-runs `bin/exec`, the stack is
 * re-planned, and the local Worker is restarted with the new bundle.
 *
 * The stress suite rewrites it in place inside a throwaway copy of this
 * project; the checked-in value is always `v1`.
 */
export const ECHO_MARKER = "echo-v1";
