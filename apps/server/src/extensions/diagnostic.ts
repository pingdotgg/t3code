export function extensionDiagnostic(cause: unknown, depth = 0): string {
  if (cause instanceof Error) {
    const detail =
      cause.cause === undefined || depth >= 3
        ? ""
        : `: ${extensionDiagnostic(cause.cause, depth + 1)}`;
    return `${cause.message}${detail}`.slice(0, 8192);
  }
  return String(cause).slice(0, 8192);
}
