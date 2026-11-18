import type { ProviderInstallDiagnostics } from "@t3tools/contracts";
import { T, Var } from "gt-react";

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
      <summary className="cursor-pointer py-1">
        <T>Installation details</T>
      </summary>
      <div className="space-y-2 py-2">
        <p>{diagnostics.step}</p>
        {operationId ? (
          <p className="break-all font-mono">
            <T>
              Attempt: <Var>{operationId}</Var>
            </T>
          </p>
        ) : null}
        {diagnostics.systemError ? <p>{diagnostics.systemError}</p> : null}
        {diagnostics.exitCode !== null ? (
          <p>
            <T>
              Exit code: <Var>{diagnostics.exitCode}</Var>
            </T>
          </p>
        ) : null}
        {diagnostics.signal !== null ? (
          <p>
            <T>
              Exit signal: <Var>{diagnostics.signal}</Var>
            </T>
          </p>
        ) : null}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono">
          {diagnostics.stderr || <T>No startup error output was captured for this check.</T>}
        </pre>
        {diagnostics.truncated ? (
          <p>
            <T>Some startup output was omitted or truncated.</T>
          </p>
        ) : null}
      </div>
    </details>
  );
}
