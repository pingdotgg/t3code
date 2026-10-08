import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@cz/client-runtime/environment";
import {
  type BriefJob,
  type BriefLine,
  briefLineCount,
  buildMorningBrief,
  formatBriefSince,
  morningBriefIsEmpty,
  morningBriefSummary,
} from "@cz/client-runtime/decisions/morningBrief";
import type { EnvironmentThreadShell } from "@cz/client-runtime/state/models";
import { type EnvironmentId, ThreadId } from "@cz/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, SunriseIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { undoLatestThreadAction } from "~/hooks/showThreadUndoNotice";
import { useThreadActions } from "~/hooks/useThreadActions";
import { type DecisionEntry, decisionEnvironment, useMachineBriefs } from "~/state/decisions";
import { useAtomCommand } from "~/state/use-atom-command";
import { fleetAtom } from "../fleet/MachineLoad";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const UNDO_WINDOW_MS = 5_000;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The Morning brief, pinned above Needs you: what happened since the owner
 * last looked, on the machines the filter shows. Each machine's server writes
 * its lines; opening the feed marks it seen there, so the next brief starts
 * from this visit.
 */
export function MorningBriefCard({
  environmentIds,
  decisions,
  threads,
  jobs,
  now,
  machineLabel,
  onOpenDecision,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly decisions: ReadonlyArray<DecisionEntry>;
  /** Threads on the machines the filter shows. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly jobs: ReadonlyArray<BriefJob>;
  readonly now: number;
  readonly machineLabel: (environmentId: string) => string;
  readonly onOpenDecision: (key: string) => void;
}) {
  const machines = useMachineBriefs(environmentIds);
  const fleet = useAtomValue(fleetAtom);
  const brief = useMemo(
    () =>
      buildMorningBrief({
        machines,
        decisions,
        threads,
        jobs,
        fleet: fleet.filter((machine) => environmentIds.includes(machine.environmentId)),
      }),
    [machines, decisions, threads, jobs, fleet, environmentIds],
  );
  const markSeen = useAtomCommand(decisionEnvironment.briefSeen, { reportFailure: false });
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState !== "visible") return;
      for (const environmentId of environmentIds) {
        void markSeen({ environmentId, input: undefined });
      }
    };
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [environmentIds, markSeen]);
  const [folded, setFolded] = useState(false);

  if (morningBriefIsEmpty(brief)) return null;
  const manyMachines = new Set(threads.map((thread) => thread.environmentId)).size > 1;

  if (folded) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/40"
        onClick={() => setFolded(false)}
      >
        <SunriseIcon className="size-4 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">Morning brief</span>
        <span className="truncate">{morningBriefSummary(brief)}</span>
      </button>
    );
  }

  const top = brief.decisions.top;
  return (
    <section
      aria-label="Morning brief"
      className="space-y-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <SunriseIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Morning brief</h2>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {brief.since === null
            ? null
            : `since you last looked, ${formatBriefSince(brief.since, now)}`}
          {brief.writing ? " · writing…" : null}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setFolded(true)}>
          Fold
        </Button>
      </header>

      {brief.done.length > 0 ? (
        <BriefSection title="Done">
          {brief.done.map((line) => (
            <BriefLineRow
              key={line.key}
              line={line}
              machineLabel={manyMachines ? machineLabel : null}
            />
          ))}
        </BriefSection>
      ) : null}

      {brief.failed.length > 0 ? (
        <BriefSection title="Failed or stopped">
          {brief.failed.map((line) => (
            <BriefLineRow
              key={line.key}
              line={line}
              machineLabel={manyMachines ? machineLabel : null}
            />
          ))}
        </BriefSection>
      ) : null}

      {brief.decisions.total > 0 || brief.waiting.length > 0 ? (
        <BriefSection title="Needs you">
          {top ? (
            <li>
              <button
                type="button"
                className="block w-full rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent/40"
                onClick={() => onOpenDecision(`${top.environmentId}:${top.item.id}`)}
              >
                <span className="font-medium text-foreground">
                  {plural(brief.decisions.total, "Decision")}
                </span>
                <span className="text-muted-foreground">
                  {": "}
                  {brief.decisions.byProject
                    .map(({ project, count }) => `${count} ${project}`)
                    .join(", ")}
                </span>
              </button>
            </li>
          ) : null}
          {brief.waiting.map((thread) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <ThreadLink environmentId={thread.environmentId} threadId={thread.id}>
                <span className="text-foreground">{thread.title}</span>
                <span className="text-muted-foreground">
                  {thread.hasPendingApprovals ? " is waiting for approval" : " asked you something"}
                </span>
              </ThreadLink>
            </li>
          ))}
        </BriefSection>
      ) : null}

      {brief.machines.length > 0 ? (
        <BriefSection title="Machines">
          {brief.machines.map((machine) => (
            <li key={machine.environmentId}>
              <Link to="/fleet" className="block rounded-md px-1 py-0.5 text-sm hover:bg-accent/40">
                <span className="font-medium text-foreground">{machine.label}</span>
                <span className="text-muted-foreground"> {machine.problem}</span>
              </Link>
            </li>
          ))}
        </BriefSection>
      ) : null}
    </section>
  );
}

function BriefSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function ThreadLink({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly children: ReactNode;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      className="block min-w-0 rounded-md px-1 py-0.5 text-sm hover:bg-accent/40"
    >
      {children}
    </Link>
  );
}

/**
 * "hll: Andras rigged in game; level editor merged". One thread opens it;
 * several expand in place to the threads, each a link. Failed and stopped
 * lines carry their one action.
 */
function BriefLineRow({
  line,
  machineLabel,
}: {
  readonly line: BriefLine;
  readonly machineLabel: ((environmentId: string) => string) | null;
}) {
  const [open, setOpen] = useState(false);
  const retry = useAtomCommand(decisionEnvironment.retryThreads, "retry threads");
  const { archiveThread } = useThreadActions();
  const single = line.threads.length === 1 && line.jobs.length === 0 ? line.threads[0] : null;

  const onRetry = async () => {
    const byMachine = new Map<EnvironmentId, string[]>();
    for (const thread of line.threads) {
      byMachine.set(thread.environmentId, [
        ...(byMachine.get(thread.environmentId) ?? []),
        thread.threadId,
      ]);
    }
    let sent = 0;
    for (const [environmentId, threadIds] of byMachine) {
      const result = await retry({ environmentId, input: { threadIds } });
      if (result._tag === "Success") sent += result.value;
    }
    if (sent > 0) {
      toastManager.add({ type: "success", title: `Asked ${plural(sent, "thread")} to try again` });
    }
  };
  const onDismiss = async () => {
    const results = await Promise.all(
      line.threads.map((thread) =>
        archiveThread(scopeThreadRef(thread.environmentId, ThreadId.make(thread.threadId))),
      ),
    );
    const archived = results.filter((result) => result._tag === "Success").length;
    if (archived === 0) return;
    toastManager.add({
      type: "success",
      title: `Archived ${plural(archived, "thread")}`,
      timeout: UNDO_WINDOW_MS,
      actionProps: { children: "Undo", onClick: () => undoLatestThreadAction() },
    });
  };

  const text = (
    <>
      <span className="font-medium text-foreground">{line.label}</span>
      <span className="text-muted-foreground">: </span>
      <span className="text-foreground">{line.text}</span>
    </>
  );
  return (
    <li>
      <div className="flex items-start gap-1">
        {single ? (
          <div className="min-w-0 flex-1">
            <ThreadLink environmentId={single.environmentId} threadId={single.threadId}>
              {text}
            </ThreadLink>
          </div>
        ) : line.threads.length === 0 ? (
          <Link
            to="/schedules"
            className="block min-w-0 flex-1 rounded-md px-1 py-0.5 text-sm hover:bg-accent/40"
          >
            {text}
          </Link>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-start gap-1 rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent/40"
            onClick={() => setOpen((current) => !current)}
          >
            <span className="min-w-0 flex-1">
              {text}
              <span className="text-muted-foreground"> · {briefLineCount(line)}</span>
            </span>
            {open ? (
              <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        )}
        {line.action === "open" || line.threads.length === 0 ? null : (
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={() => void (line.action === "retry" ? onRetry() : onDismiss())}
          >
            {line.action === "retry" ? "Retry" : "Dismiss"}
          </Button>
        )}
      </div>
      {open && !single ? (
        <ul className="mt-0.5 ml-2 space-y-0.5 border-l border-border pl-2">
          {line.threads.map((thread) => (
            <li key={`${thread.environmentId}:${thread.threadId}`}>
              <ThreadLink environmentId={thread.environmentId} threadId={thread.threadId}>
                <span className="block truncate text-muted-foreground">
                  {thread.title}
                  {machineLabel ? ` · ${machineLabel(thread.environmentId)}` : null}
                </span>
              </ThreadLink>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
