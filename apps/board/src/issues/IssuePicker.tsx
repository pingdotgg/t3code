import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { IssueListEntry } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { CircleDot, ExternalLink, Github, X } from "lucide-react";
import { type ComponentType, type KeyboardEvent, useState } from "react";

import { openInBrowser } from "../browser/browserTabs";
import { issueTrackerEnvironment } from "../state/issues";
import { Tooltip } from "../ui/Tooltip";
import { GITHUB, LINEAR } from "./issueLinks";
import { IssueResults } from "./IssueResults";
import type { PickerMode, PickerValue } from "./pick";
import { LinearIcon } from "./LinearIcon";
import { useIssueSearch } from "./useIssueSearch";

type Icon = ComponentType<{ className?: string }>;

const MODES: ReadonlyArray<{ id: PickerMode; label: string; Icon: Icon; placeholder: string }> = [
  { id: "github", label: "GitHub", Icon: Github, placeholder: "Search GitHub issues" },
  { id: "linear", label: "Linear", Icon: LinearIcon, placeholder: "Search Linear issues" },
];

const field =
  "h-9 w-full min-w-0 rounded-md border border-line bg-bg pr-2 pl-8 text-sm text-fg placeholder:text-faint focus:border-focus focus:ring-[3px] focus:ring-focus/30 focus:outline-none";

/** Orca's Create From row: an icon tab for each tracker and a search box. A pick replaces the box with a pill. */
export function IssuePicker({
  project,
  value,
  onChange,
  onOpenIntegrations,
}: {
  project: EnvironmentProject;
  value: PickerValue;
  onChange: (value: PickerValue) => void;
  onOpenIntegrations?: (() => void) | undefined;
}) {
  const { mode, text, source } = value;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const current = MODES.find((entry) => entry.id === mode)!;
  const listing = source === null && open;

  const trackers = AsyncResult.getOrElse(
    useAtomValue(
      issueTrackerEnvironment.connections({ environmentId: project.environmentId, input: {} }),
    ),
    () => null,
  );
  const linear = trackers?.trackers.find((tracker) => tracker.tracker === LINEAR);
  const linearSetup =
    trackers === null
      ? null
      : linear?.connected !== true || linear.account === null
        ? "Connect Linear in Settings to search issues."
        : trackers.bindings[project.id]?.tracker !== LINEAR
          ? "Bind this project to a Linear team in Settings to search its issues."
          : null;

  const issues = useIssueSearch(
    project,
    mode === "linear" ? LINEAR : GITHUB,
    text,
    listing && !(mode === "linear" && linearSetup !== null),
  );

  const hint =
    mode === "linear" && linearSetup !== null
      ? linearSetup
      : mode === "github"
        ? "Start typing to search GitHub issues."
        : "No matching Linear issues.";

  const rows = issues.rows;
  const pick = (entry: IssueListEntry) => {
    onChange({ ...value, source: entry });
    setOpen(false);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
      setHighlight((at) => (rows.length === 0 ? 0 : (at + step) % rows.length));
    } else if (event.key === "Enter" && listing) {
      const row = rows[Math.min(highlight, rows.length - 1)];
      if (row !== undefined) {
        event.preventDefault();
        pick(row);
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        role="tablist"
        aria-label="Create from"
        className="flex min-w-0 items-center gap-1 border-b border-line/40"
      >
        {MODES.map(({ id, label, Icon }) => (
          <Tooltip key={id} text={label} side="bottom">
            <button
              type="button"
              role="tab"
              aria-selected={mode === id}
              aria-label={label}
              data-mode={id}
              onClick={() => {
                onChange({ mode: id, text: id === mode ? text : "", source: null });
                setOpen(false);
              }}
              className={`relative inline-flex h-7 items-center justify-center rounded-md px-2 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-fg after:transition-opacity hover:text-fg ${mode === id ? "text-fg after:opacity-100" : "text-muted after:opacity-0"}`}
            >
              <Icon className="size-3.5" />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="relative min-w-0">
        {source !== null ? (
          <div
            data-testid="picker-pill"
            className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-sm"
          >
            <CircleDot className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate leading-none font-medium text-fg">
              {source.displayKey} {source.title}
            </span>
            <button
              type="button"
              aria-label="Open in the browser"
              onClick={() => openInBrowser(source.url)}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:text-fg"
            >
              <ExternalLink className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Clear the picked source"
              onClick={() => onChange({ ...value, text: "", source: null })}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <>
            <current.Icon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={text}
              aria-label={current.label}
              placeholder={current.placeholder}
              onPointerDown={() => setOpen(true)}
              onChange={(event) => {
                performance.mark("board:issue-search", { detail: { text: event.target.value } });
                onChange({ ...value, text: event.target.value });
                setHighlight(0);
                setOpen(true);
              }}
              onKeyDown={keys}
              className={field}
            />
            {listing && (
              <IssueResults
                rows={rows}
                loading={issues.loading}
                error={issues.error}
                hint={hint}
                highlight={highlight}
                onHighlight={setHighlight}
                onPick={pick}
                action={
                  mode === "linear" && linearSetup !== null && onOpenIntegrations !== undefined
                    ? { label: "Open Integrations", run: onOpenIntegrations }
                    : null
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
