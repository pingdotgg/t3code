import { FileDiff } from "@pierre/diffs/react";
import { toolCallDiff } from "@t3tools/client-runtime/work-log/file-change-diff";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { useRenderedAppearance } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

type FileChange = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

const preClassName =
  "max-h-80 overflow-auto rounded-md border border-border/60 bg-muted/20 p-2 font-mono text-(length:--font-size-code,var(--text-2xs)) whitespace-pre-wrap break-words text-muted-foreground select-text";

export function FileChangeInlineDiff(props: {
  readonly item: FileChange;
  readonly pending: boolean;
  readonly error: string | null;
}) {
  const appearance = useRenderedAppearance();
  if (props.pending) return <p className="text-muted-foreground italic">Loading diff…</p>;
  if (props.error)
    return <p className="text-destructive">Couldn&apos;t load diff: {props.error}</p>;
  const diff = toolCallDiff(props.item);
  const renderable = getRenderablePatch(diff.patch, `tool-call-inline:${appearance}`);
  if (renderable === null && diff.content.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {renderable?.kind === "files" ? (
        <div className="max-h-80 overflow-auto rounded-md border border-border/60">
          <DiffWorkerPoolProvider>
            {renderable.files.map((fileDiff) => (
              <FileDiff
                key={resolveFileDiffPath(fileDiff)}
                fileDiff={fileDiff}
                options={{
                  diffStyle: "unified",
                  overflow: "wrap",
                  // The row already names the file; a multi-file patch still needs each name.
                  disableFileHeader: renderable.files.length === 1,
                  theme: resolveDiffThemeName(appearance),
                  themeType: appearance,
                  preferredHighlighter: PREFERRED_HIGHLIGHTER,
                }}
              />
            ))}
          </DiffWorkerPoolProvider>
        </div>
      ) : renderable?.kind === "raw" ? (
        <pre className={preClassName}>{renderable.text}</pre>
      ) : (
        diff.content.map(({ label, text }) => (
          <div key={label} className="space-y-1">
            <p className="text-muted-foreground">{label}</p>
            <pre className={preClassName}>{text === "" ? "Empty content." : text}</pre>
          </div>
        ))
      )}
      {diff.truncated ? (
        <p className="text-muted-foreground italic">The recorded change was truncated.</p>
      ) : null}
    </div>
  );
}
