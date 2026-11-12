import {
  AuthOrchestrationOperateScope,
  OPEN_OWNED_WORK_STATUSES,
  OWNED_WORK_CLOSURE_UX,
  OwnedWorkItemId,
  ThreadId,
  type EnvironmentId,
  type OwnedWorkHistoryEntry,
  type OwnedWorkItem,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ClipboardListIcon, HistoryIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadProjection } from "~/state/entities";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

function statusLabel(status: OwnedWorkItem["status"]): string {
  switch (status) {
    case "assigned":
      return "Assigned";
    case "claimed":
      return "Claimed";
    case "in_progress":
      return "In progress";
    case "on_hold":
      return "On hold";
    case "needs_attention":
      return "Needs attention";
    case "handed_off":
      return "Handed off";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

function historyLine(entry: OwnedWorkHistoryEntry): string {
  const note = entry.note?.trim();
  const reason = entry.closureReason ? ` (${entry.closureReason})` : "";
  return note ? `${entry.kind}${reason}: ${note}` : `${entry.kind}${reason}`;
}

export function ThreadOwnedWorkPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly density: "full" | "compact" | "essential";
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const items = useQuietThreadProjection(threadRef)?.projection.thread.ownedWorkItems ?? [];
  const openItems = items.filter((item) => OPEN_OWNED_WORK_STATUSES.has(item.status));
  const closedItems = items.filter((item) => !OPEN_OWNED_WORK_STATUSES.has(item.status));
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [title, setTitle] = useState("");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(closedItems.length > 0 && openItems.length === 0);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  const assign = useOrchestrationCommand(threadEnvironment.assignOwnedWork, {
    label: "assign owned work",
  });
  const claim = useOrchestrationCommand(threadEnvironment.claimOwnedWork, {
    label: "claim owned work",
  });
  const handoff = useOrchestrationCommand(threadEnvironment.handoffOwnedWork, {
    label: "handoff owned work",
  });
  const resume = useOrchestrationCommand(threadEnvironment.resumeOwnedWork, {
    label: "resume owned work",
  });
  const complete = useOrchestrationCommand(threadEnvironment.completeOwnedWork, {
    label: "complete owned work",
  });
  const cancel = useOrchestrationCommand(threadEnvironment.cancelOwnedWork, {
    label: "cancel owned work",
  });

  if (items.length === 0 && props.density !== "full") return null;

  const reportFailure = (failureTitle: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const run = async (
    itemId: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
  ) => {
    if (
      busyItemId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyItemId(itemId);
    const result = await action();
    setBusyItemId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(failureTitle, squashAtomCommandFailure(result));
    }
  };

  const onAssign = async () => {
    const trimmed = title.trim();
    if (trimmed === "" || busyItemId !== null) return;
    if (!readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)) return;
    const itemId = OwnedWorkItemId.make(`owned-work:${randomUUID()}`);
    setBusyItemId(itemId);
    const result = await assign({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        itemId,
        title: trimmed,
        createdByThreadId: props.threadId,
      },
    });
    setBusyItemId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not assign work", squashAtomCommandFailure(result));
      return;
    }
    setTitle("");
  };

  const compactSummary =
    openItems.length === 0
      ? closedItems.length === 0
        ? null
        : `${closedItems.length} closed`
      : `${openItems.length} open`;

  if (props.density !== "full") {
    if (compactSummary === null) return null;
    return (
      <ThreadDetailsSection
        headingId="thread-details-work-heading"
        title="Work"
        separated
        showHeading={props.density === "compact"}
      >
        <div className={cn(THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS, "flex flex-col gap-1 px-2.5")}>
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ClipboardListIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>{compactSummary}</span>
          </div>
          {openItems.slice(0, 3).map((item) => (
            <div
              key={item.id}
              className="flex min-w-0 items-baseline justify-between gap-2 text-sm"
            >
              <span className="truncate font-medium">{item.title}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {statusLabel(item.status)}
              </span>
            </div>
          ))}
        </div>
      </ThreadDetailsSection>
    );
  }

  return (
    <ThreadDetailsSection headingId="thread-details-work-heading" title="Work" separated>
      <div className="flex flex-col gap-2 px-2.5 pb-1">
        {canOperate ? (
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void onAssign();
            }}
          >
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Assign work…"
              className="border-border/60 bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              disabled={busyItemId !== null}
            />
            <ThreadDetailsControl
              size="xs"
              variant="outline"
              part="meta"
              type="submit"
              disabled={busyItemId !== null || title.trim() === ""}
            >
              Assign
            </ThreadDetailsControl>
          </form>
        ) : null}

        {openItems.length === 0 && closedItems.length === 0 ? (
          <p className="text-muted-foreground text-xs">No owned work on this thread.</p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {openItems.map((item) => {
            const ownerThreadId = item.claimedByThreadId ?? item.assigneeThreadId;
            const waiting = item.status === "on_hold" || item.status === "needs_attention";
            const reason = item.holdReason ?? item.attentionReason;
            return (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-md border border-border/50 p-2"
              >
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.title}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {statusLabel(item.status)}
                  </span>
                </div>
                {ownerThreadId ? (
                  <p className="text-muted-foreground truncate text-xs">{ownerThreadId}</p>
                ) : null}
                {reason ? (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{reason}</p>
                ) : null}
                {item.progress ? (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{item.progress}</p>
                ) : null}
                {canOperate ? (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {item.status === "assigned" || item.status === "handed_off" ? (
                      <ThreadDetailsControl
                        size="xs"
                        variant="outline"
                        part="meta"
                        disabled={busyItemId !== null}
                        onClick={() =>
                          void run(
                            item.id,
                            () =>
                              claim({
                                environmentId: props.environmentId,
                                input: {
                                  threadId: props.threadId,
                                  itemId: item.id,
                                  claimedByThreadId: props.threadId,
                                },
                              }),
                            "Could not claim work",
                          )
                        }
                      >
                        Claim
                      </ThreadDetailsControl>
                    ) : null}
                    {waiting ? (
                      <ThreadDetailsControl
                        size="xs"
                        variant="outline"
                        part="meta"
                        disabled={busyItemId !== null}
                        onClick={() =>
                          void run(
                            item.id,
                            () =>
                              resume({
                                environmentId: props.environmentId,
                                input: {
                                  threadId: props.threadId,
                                  itemId: item.id,
                                  actorThreadId: props.threadId,
                                },
                              }),
                            "Could not resume work",
                          )
                        }
                      >
                        Resume
                      </ThreadDetailsControl>
                    ) : null}
                    {item.status !== "assigned" && item.status !== "handed_off" ? (
                      <ThreadDetailsControl
                        size="xs"
                        variant="outline"
                        part="meta"
                        tone="primary"
                        disabled={busyItemId !== null}
                        onClick={() =>
                          void run(
                            item.id,
                            () =>
                              complete({
                                environmentId: props.environmentId,
                                input: {
                                  threadId: props.threadId,
                                  itemId: item.id,
                                  closureReason: OWNED_WORK_CLOSURE_UX.done.reason,
                                  actorThreadId: props.threadId,
                                },
                              }),
                            "Could not complete work",
                          )
                        }
                      >
                        {OWNED_WORK_CLOSURE_UX.done.label}
                      </ThreadDetailsControl>
                    ) : null}
                    <ThreadDetailsControl
                      size="xs"
                      variant="outline"
                      part="meta"
                      tone="destructive"
                      disabled={busyItemId !== null}
                      onClick={() =>
                        void run(
                          item.id,
                          () =>
                            cancel({
                              environmentId: props.environmentId,
                              input: {
                                threadId: props.threadId,
                                itemId: item.id,
                                actorThreadId: props.threadId,
                              },
                            }),
                          "Could not cancel work",
                        )
                      }
                    >
                      {OWNED_WORK_CLOSURE_UX.cancel.label}
                    </ThreadDetailsControl>
                    {item.status !== "assigned" ? (
                      <ThreadDetailsControl
                        size="xs"
                        variant="outline"
                        part="meta"
                        disabled={busyItemId !== null}
                        onClick={() => {
                          const toThreadId = window.prompt(
                            "Handoff to thread id",
                            item.assigneeThreadId ?? "",
                          );
                          if (toThreadId === null || toThreadId.trim() === "") return;
                          void run(
                            item.id,
                            () =>
                              handoff({
                                environmentId: props.environmentId,
                                input: {
                                  threadId: props.threadId,
                                  itemId: item.id,
                                  toThreadId: ThreadId.make(toThreadId.trim()),
                                  actorThreadId: props.threadId,
                                },
                              }),
                            "Could not hand off work",
                          );
                        }}
                      >
                        {OWNED_WORK_CLOSURE_UX.handoff.label}
                      </ThreadDetailsControl>
                    ) : null}
                    <ThreadDetailsControl
                      size="xs"
                      variant="ghost"
                      part="meta"
                      onClick={() =>
                        setExpandedHistoryId((current) => (current === item.id ? null : item.id))
                      }
                    >
                      <HistoryIcon className="size-3" aria-hidden />
                      History
                    </ThreadDetailsControl>
                  </div>
                ) : null}
                {expandedHistoryId === item.id ? (
                  <ol className="text-muted-foreground flex list-decimal flex-col gap-0.5 pl-4 text-xs">
                    {(item.history ?? []).map((entry) => (
                      <li
                        key={`${entry.at}:${entry.kind}:${entry.note ?? ""}:${entry.closureReason ?? ""}`}
                      >
                        {historyLine(entry)}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ul>

        {closedItems.length > 0 ? (
          <div className="flex flex-col gap-1">
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              onClick={() => setShowHistory((value) => !value)}
            >
              <HistoryIcon className="size-3" aria-hidden />
              {showHistory ? "Hide history" : `History (${closedItems.length})`}
            </ThreadDetailsControl>
            {showHistory ? (
              <ul className="flex flex-col gap-1.5">
                {closedItems.map((item) => (
                  <li key={item.id} className="flex flex-col gap-0.5 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-foreground">{item.title}</span>
                      <span className="text-muted-foreground shrink-0">
                        {statusLabel(item.status)}
                        {item.closureReason ? ` · ${item.closureReason}` : ""}
                      </span>
                    </div>
                    <ol className="text-muted-foreground flex list-decimal flex-col gap-0.5 pl-4">
                      {(item.history ?? []).map((entry) => (
                        <li
                          key={`${entry.at}:${entry.kind}:${entry.note ?? ""}:${entry.closureReason ?? ""}`}
                        >
                          {historyLine(entry)}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
