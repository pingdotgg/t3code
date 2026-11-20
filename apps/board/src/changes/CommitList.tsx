import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";

import { reviewEnvironment } from "../state/changes";
import { Tooltip } from "../ui/Tooltip";
import { CommitRow } from "./CommitRow";
import { useRevisionRefresh } from "./useDiffPreview";

/**
 * The branch's commits under Orca's collapsed header at the bottom of the tab. A commit opens to its
 * files, and a file or all of them open as a diff in the main view.
 */
export function CommitList({
  environmentId,
  cwd,
  baseRef,
  revision,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  baseRef: string | null;
  revision: string;
}) {
  const [open, setOpen] = useState(false);
  const atom = reviewEnvironment.branchCommits({
    environmentId,
    input: { cwd, ...(baseRef === null ? {} : { baseRef }) },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useRevisionRefresh(revision, refresh);
  const listed = AsyncResult.getOrElse(result, () => null);
  const Chevron = open ? ChevronDown : ChevronRight;
  const failure = result._tag === "Failure" && listed === null ? Cause.squash(result.cause) : null;
  return (
    <section
      aria-label="Commits"
      data-testid="commit-list"
      className={`flex shrink-0 flex-col border-t border-line ${open ? "max-h-[45%]" : ""}`}
    >
      <header className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 uppercase hover:text-fg"
        >
          <Chevron className="size-3.5" aria-hidden />
          Commits
          {listed !== null && (
            <span className="text-faint">
              {listed.commits.length}
              {listed.truncated ? "+" : ""}
            </span>
          )}
        </button>
        <span className="flex-1" />
        <Tooltip text="Refresh commits" side="top" align="end">
          <button
            type="button"
            aria-label="Refresh commits"
            onClick={refresh}
            className="grid size-5 place-items-center rounded hover:bg-hover hover:text-fg"
          >
            <RefreshCw className={`size-3 ${result.waiting ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </Tooltip>
      </header>
      {open && (
        <div role="list" className="min-h-0 overflow-y-auto px-1 pb-1">
          {failure !== null ? (
            <p role="alert" className="px-2 py-1 text-[12px] text-red-300">
              {failure instanceof Error ? failure.message : String(failure)}
            </p>
          ) : listed === null ? (
            <p className="px-2 py-1 text-[12px] text-faint">Loading commits</p>
          ) : listed.commits.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-faint">No commits on this branch</p>
          ) : (
            listed.commits.map((commit) => (
              <CommitRow key={commit.sha} environmentId={environmentId} cwd={cwd} commit={commit} />
            ))
          )}
        </div>
      )}
    </section>
  );
}
