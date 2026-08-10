import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

const WINDOWS_FILE_RETRY_DELAYS = [25, 75, 150, 300, 600] as const;
const TRANSIENT_WINDOWS_SYSTEM_ERROR_TAGS = new Set([
  "Busy",
  "PermissionDenied",
  "WouldBlock",
]);
const TRANSIENT_WINDOWS_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "EPERM",
  "ETXTBSY",
]);

function readErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { readonly code?: unknown }).code;
  if (typeof code === "string") return code.toUpperCase();
  const cause = (value as { readonly cause?: unknown }).cause;
  return cause === value ? null : readErrorCode(cause);
}

export function isTransientWindowsFileSystemError(error: PlatformError.PlatformError): boolean {
  if (TRANSIENT_WINDOWS_SYSTEM_ERROR_TAGS.has(error.reason._tag)) {
    return true;
  }
  return TRANSIENT_WINDOWS_ERROR_CODES.has(readErrorCode(error.reason) ?? "");
}

/**
 * Windows scanners, indexers, sync clients, and antivirus software can briefly
 * hold a file between our temporary-file write and atomic rename. Effect
 * normalizes those failures to Busy / WouldBlock / PermissionDenied (or an
 * Unknown reason retaining the original Node errno). Retry only that bounded
 * class; permanent filesystem failures still surface to the caller.
 */
export function retryWindowsFileSystemOperation<A>(
  operation: Effect.Effect<A, PlatformError.PlatformError>,
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly delaysMs?: readonly number[];
  },
): Effect.Effect<A, PlatformError.PlatformError> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") return operation;
  const delays = options?.delaysMs ?? WINDOWS_FILE_RETRY_DELAYS;

  const attempt = (index: number): Effect.Effect<A, PlatformError.PlatformError> =>
    operation.pipe(
      Effect.catch((error) => {
        const delay = delays[index];
        if (delay === undefined || !isTransientWindowsFileSystemError(error)) {
          return Effect.fail(error);
        }
        return Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(attempt(index + 1)));
      }),
    );

  return attempt(0);
}
