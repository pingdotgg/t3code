import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { VcsStatusResult } from "@t3tools/contracts";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ExternalLink,
  GitBranch,
  GitCompareArrows,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { useContext } from "react";

import { openInBrowser } from "../browser/browserTabs";
import type { FilesRoot } from "../files/target";
import { changesPrefsAtom } from "../state/changesView";
import { PopMenu } from "../ui/PopMenu";
import { Tooltip } from "../ui/Tooltip";

const ICON =
  "grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg";

// A stable function, so focus moves when the box opens and not on every keystroke.
const focusOnOpen = (node: HTMLInputElement | null) => node?.focus();

/**
 * The top of Orca's source control view: the pull request with search and more, the branch with
 * the root picker, and the base with its ahead and behind counts and a link to the pull request.
 */
export function ChangesHeader({
  roots,
  root,
  base,
  status,
  filter,
  onFilter,
  onRoot,
  onRefresh,
}: {
  roots: ReadonlyArray<FilesRoot>;
  root: FilesRoot;
  base: string | null;
  status: VcsStatusResult | null;
  /** The text the file lists are filtered by, or null while the filter box is closed. */
  filter: string | null;
  onFilter: (filter: string | null) => void;
  onRoot: (cwd: string) => void;
  onRefresh: () => void;
}) {
  const registry = useContext(RegistryContext);
  const prefs = useAtomValue(changesPrefsAtom);
  const pr = status?.pr ?? null;
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex h-6 items-center gap-1">
        {pr !== null && (
          <button
            type="button"
            onClick={() => openInBrowser(pr.url)}
            className="flex items-center gap-1 rounded-md px-1 text-[12px] font-semibold text-fg hover:bg-hover"
          >
            <GitCompareArrows className="size-3.5 text-muted" aria-hidden />
            PR #{pr.number}
          </button>
        )}
        <span className="flex-1" />
        <Tooltip text="Filter files by name" side="bottom" align="end">
          <button
            type="button"
            aria-label="Filter files by name"
            aria-expanded={filter !== null}
            onClick={() => onFilter(filter === null ? "" : null)}
            className={ICON}
          >
            <Search className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        <PopMenu
          label="More source control actions"
          trigger={<MoreHorizontal className="size-3.5" aria-hidden />}
          triggerClass={ICON}
          items={[
            {
              label: prefs.asTree ? "View as list" : "View as tree",
              onSelect: () => registry.set(changesPrefsAtom, { ...prefs, asTree: !prefs.asTree }),
            },
            { label: "Refresh changes", onSelect: onRefresh },
          ]}
        />
      </div>
      {filter !== null && (
        <input
          ref={focusOnOpen}
          type="search"
          aria-label="Filter files by name"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onFilter(null);
          }}
          placeholder="Filter files by name"
          className="rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-fg placeholder:text-faint"
        />
      )}
      <div className="relative flex h-5 items-center gap-1.5 text-[12px]">
        <GitBranch className="size-3.5 shrink-0 text-fg" aria-hidden />
        <span
          data-testid="branch-name"
          className="min-w-0 truncate font-mono font-semibold text-fg"
        >
          {status?.refName ?? root.label}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
        {/* The picker is the whole row, drawn over it, so the branch reads as Orca's branch button. */}
        <select
          aria-label="Root"
          value={root.cwd}
          onChange={(event) => onRoot(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {roots.map((entry) => (
            <option key={entry.cwd} value={entry.cwd} className="bg-panel">
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex h-5 items-center gap-1.5 text-[12px] text-muted">
        <ArrowRight className="size-3.5 shrink-0" aria-hidden />
        <span data-testid="base-name" className="min-w-0 truncate font-mono font-semibold">
          {base ?? "default branch"}
        </span>
        <span className="flex-1" />
        {status !== null && status.aheadCount > 0 && (
          <span className="flex items-center text-[11px] text-emerald-300">
            <ArrowUp className="size-3" aria-hidden />
            {status.aheadCount}
          </span>
        )}
        {status !== null && status.behindCount > 0 && (
          <span className="flex items-center text-[11px] text-muted">
            <ArrowDown className="size-3" aria-hidden />
            {status.behindCount}
          </span>
        )}
        {pr !== null && (
          <Tooltip text="Open pull request" side="bottom" align="end">
            <button
              type="button"
              aria-label="Open pull request"
              onClick={() => openInBrowser(pr.url)}
              className={ICON}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
