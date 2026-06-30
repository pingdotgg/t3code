import { FileDiff } from "@pierre/diffs/react";
import type { EnvironmentApi, TicketDiff as TicketDiffData, TicketId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { getTicketDiff } from "~/workflow/boardRpc";

type TicketDiffLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly diff: TicketDiffData }
  | { readonly status: "error"; readonly message: string };

export function TicketDiff({
  api,
  ticketId,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: TicketId;
}) {
  const { resolvedTheme } = useTheme();
  const [loadState, setLoadState] = useState<TicketDiffLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });

    void getTicketDiff(api, ticketId).then(
      (diff) => {
        if (!cancelled) {
          setLoadState({ status: "loaded", diff });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({ status: "error", message: errorMessage(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [api, ticketId]);

  if (loadState.status === "loading") {
    return (
      <section className="rounded-md border border-border/70 bg-card/35 p-3 text-sm text-muted-foreground">
        Loading diff...
      </section>
    );
  }

  if (loadState.status === "error") {
    return (
      <section className="rounded-md border border-destructive/35 bg-destructive/6 p-3 text-sm text-destructive-foreground">
        {loadState.message}
      </section>
    );
  }

  return <TicketDiffContent diff={loadState.diff} resolvedTheme={resolvedTheme} />;
}

export function TicketDiffContent({
  diff,
  resolvedTheme,
}: {
  readonly diff: TicketDiffData;
  readonly resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = useMemo(
    () => getRenderablePatch(diff.patch, `workflow-ticket:${diff.ticketId}:${resolvedTheme}`),
    [diff.patch, diff.ticketId, resolvedTheme],
  );

  return (
    <section className="flex min-h-0 flex-col gap-3 rounded-md border border-border/70 bg-card/35 p-3">
      <header className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">Accumulated diff</h3>
        <p className="truncate font-mono text-[11px] text-muted-foreground">Base {diff.baseRef}</p>
      </header>
      {diff.files.length > 0 ? (
        <ul className="space-y-1">
          {diff.files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 rounded-md bg-background/70 px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
                {file.path}
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                <DiffStatLabel additions={file.additions} deletions={file.deletions} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No changed files.</p>
      )}
      {diff.truncated ? <p className="text-xs text-warning-foreground">Patch truncated.</p> : null}
      {!renderablePatch ? (
        <p className="text-xs text-muted-foreground">No patch available.</p>
      ) : renderablePatch.kind === "raw" ? (
        <pre className="max-h-80 overflow-auto rounded-md border border-border/70 bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
          {renderablePatch.text}
        </pre>
      ) : (
        <div className="diff-render-surface max-h-[42rem] overflow-auto rounded-md border border-border/70 bg-background/70 p-2">
          {renderablePatch.files.map((fileDiff) => (
            <div key={buildFileDiffRenderKey(fileDiff)} className="mb-2 last:mb-0">
              <FileDiff
                fileDiff={fileDiff}
                options={{
                  collapsed: false,
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                }}
              />
              <span className="sr-only">{resolveFileDiffPath(fileDiff)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load ticket diff.";
}
