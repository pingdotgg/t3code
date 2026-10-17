let suspendedLimit: number | undefined;

// Skip Effect definition-site stack captures during production module evaluation.
export function suspendStackTracesForAppImport(): void {
  if (!import.meta.env.PROD || suspendedLimit !== undefined) return;
  suspendedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
}

/** Called before main's startup code; returns true if the stacks were still suspended. */
export function restoreStackTraces(): boolean {
  if (suspendedLimit === undefined) return false;
  Error.stackTraceLimit = suspendedLimit;
  suspendedLimit = undefined;
  return true;
}
