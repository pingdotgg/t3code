import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";

export function isSpawnSystemError(cause: unknown): cause is NodeJS.ErrnoException {
  return (
    cause instanceof Error &&
    "syscall" in cause &&
    Predicate.isString(cause.syscall) &&
    cause.syscall.startsWith("spawn")
  );
}

export function isBadCpuTypeError(cause: unknown): boolean {
  if (cause instanceof PlatformError.PlatformError) {
    return (
      cause.reason.module === "ChildProcess" &&
      cause.reason.method === "spawn" &&
      isBadCpuTypeError(cause.cause)
    );
  }
  return (
    cause instanceof Error &&
    (("code" in cause && cause.code === "EBADARCH") || ("errno" in cause && cause.errno === -86))
  );
}

export function badCpuTypeDetail(cause: unknown): string | undefined {
  if (!(cause instanceof PlatformError.PlatformError) || !isBadCpuTypeError(cause)) return;
  const path =
    "pathOrDescriptor" in cause.reason
      ? (cause.reason.pathOrDescriptor ?? "executable")
      : "executable";
  return `Cannot run '${path}': incompatible CPU architecture (bad CPU type in executable). Install a version compatible with this server's architecture.`;
}
