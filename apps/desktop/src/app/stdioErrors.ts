import * as NodeOS from "node:os";

// libuv has no name for EDQUOT, so Node reports it as code "UNKNOWN" with the raw errno.
const EDQUOT_ERRNO = NodeOS.constants.errno.EDQUOT;

// Redirected console output can fail when its log volume is full.
export function handleStdioError(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && (error.code === "EPIPE" || error.code === "ENOSPC")) return;
    if (EDQUOT_ERRNO !== undefined && "errno" in error && error.errno === -EDQUOT_ERRNO) return;
  }
  throw error;
}
