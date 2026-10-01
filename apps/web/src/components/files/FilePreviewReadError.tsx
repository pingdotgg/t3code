import type { ProjectReadFileError } from "@t3tools/contracts";

import { getFilePreviewErrorDetails } from "./filePreviewError";

interface FilePreviewReadErrorProps {
  readonly cwd?: string | null | undefined;
  readonly relativePath?: string | null | undefined;
  readonly readError?: ProjectReadFileError | null | undefined;
  readonly fallbackError?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Renders structured read failure details for the file preview panel,
 * including attempted path, specific failure reason, and path mistake hints.
 */
export function FilePreviewReadError(props: FilePreviewReadErrorProps) {
  const details = getFilePreviewErrorDetails({
    cwd: props.cwd,
    relativePath: props.relativePath,
    readError: props.readError,
    fallbackError: props.fallbackError,
  });

  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
    >
      <div className="flex max-w-lg flex-col items-center gap-1.5">
        <p className="font-semibold text-destructive">{details.title}</p>
        <p className="text-muted-foreground">{details.explanation}</p>
      </div>

      {details.attemptedPath ? (
        <div className="flex max-w-lg flex-col items-center gap-1">
          <span className="text-2xs uppercase tracking-wider text-muted-foreground/70">
            Attempted path
          </span>
          <code className="max-w-full break-all rounded bg-muted/50 px-2 py-1 font-mono text-2xs text-foreground select-all">
            {details.attemptedPath}
          </code>
        </div>
      ) : null}

      {details.duplicateWorkspacePrefixHint ? (
        <div className="mt-1 max-w-md rounded-md border border-border/60 bg-muted/30 p-2.5 text-left text-2xs text-muted-foreground">
          <p className="font-medium text-foreground">Possible path mistake</p>
          <p className="mt-0.5 leading-normal">{details.duplicateWorkspacePrefixHint}</p>
        </div>
      ) : null}

      {props.onRetry ? (
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-1 rounded-md border border-input px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
