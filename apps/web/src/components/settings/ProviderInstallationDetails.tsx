import type { ProviderInstallDiagnostics } from "@t3tools/contracts";

export function ProviderInstallationDetails({
  diagnostics,
  operationId,
}: {
  readonly diagnostics: ProviderInstallDiagnostics | null | undefined;
  readonly operationId: string | null;
}) {
  if (!diagnostics) return null;
  return (
    <details className="min-w-0 text-left text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1">Installation details</summary>
      <div className="space-y-2 py-2">
        <p>{diagnostics.step}</p>
        {operationId ? <p className="break-all font-mono">Attempt: {operationId}</p> : null}
        {diagnostics.systemError ? <p>{diagnostics.systemError}</p> : null}
        {diagnostics.exitCode !== null ? <p>Exit code: {diagnostics.exitCode}</p> : null}
        {diagnostics.signal !== null ? <p>Exit signal: {diagnostics.signal}</p> : null}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono">
          {diagnostics.stderr || "No startup error output was captured for this check."}
        </pre>
        {diagnostics.truncated ? <p>Some startup output was omitted or truncated.</p> : null}
      </div>
    </details>
  );
}
