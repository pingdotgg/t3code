import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  isListedThreadLineage,
  OPEN_OWNED_WORK_STATUSES,
  OWNED_WORK_CLOSURE_UX,
  OwnedWorkItemId,
  specialistMcpServerEntries,
  type EnvironmentId,
  type OwnedWorkItem,
  type ThreadId,
  type ThreadSpecialist,
} from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { cn, randomUUID } from "../../lib/utils";
import { useQuietThreadProjection, useThreadShell } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function workStatusLabel(status: OwnedWorkItem["status"]): string {
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
      return "Needs you";
    case "handed_off":
      return "Handed off";
    case "completed":
      return "Done";
    case "cancelled":
      return "Canceled";
  }
}

function specialistFields(specialist: ThreadSpecialist | undefined) {
  return {
    key: specialist?.key ?? "",
    label: specialist?.label ?? "",
    instructions: specialist?.instructions ?? "",
  };
}

function editorKey(shell: EnvironmentThreadShell) {
  const specialist = shell.source.specialist;
  return [
    specialist?.key ?? "",
    specialist?.label ?? "",
    specialist?.instructions ?? "",
    shell.archivedAt ?? "",
  ].join("\0");
}

/**
 * Condensed Labs Agent Teams surface: specialist binding, open work, and role-tool counts
 * in one Thread Details section (replaces the separate Work / Specialist / Role tools panels).
 */
export function ThreadAgentTeamPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly density: "full" | "compact" | "essential";
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(threadRef);
  if (shell === null || !isListedThreadLineage(shell.lineage)) return null;
  return <ThreadAgentTeamPanelInner key={editorKey(shell)} shell={shell} {...props} />;
}

function ThreadAgentTeamPanelInner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly density: "full" | "compact" | "essential";
  readonly shell: EnvironmentThreadShell;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useQuietThreadProjection(threadRef)?.projection.thread;
  const items = projection?.ownedWorkItems ?? [];
  const openItems = items.filter((item) => OPEN_OWNED_WORK_STATUSES.has(item.status));
  const bound = props.shell.source.specialist;
  const archived = props.shell.archivedAt !== null;
  const skillCount = bound?.skills?.length ?? 0;
  const mcpCount = specialistMcpServerEntries(bound).length;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);

  const [editing, setEditing] = useState(bound === undefined && props.density === "full");
  const [fields, setFields] = useState(() => specialistFields(bound));
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  const setSpecialist = useOrchestrationCommand(threadEnvironment.setSpecialist, {
    label: "thread specialist bind",
  });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    label: "thread specialist stop",
    reportFailure: false,
  });
  const assign = useOrchestrationCommand(threadEnvironment.assignOwnedWork, {
    label: "assign owned work",
  });
  const complete = useOrchestrationCommand(threadEnvironment.completeOwnedWork, {
    label: "complete owned work",
  });
  const cancel = useOrchestrationCommand(threadEnvironment.cancelOwnedWork, {
    label: "cancel owned work",
  });
  const resume = useOrchestrationCommand(threadEnvironment.resumeOwnedWork, {
    label: "resume owned work",
  });
  const { archiveThread, unarchiveThread } = useThreadActions();

  const dirty =
    fields.key !== (bound?.key ?? "") ||
    fields.label !== (bound?.label ?? "") ||
    fields.instructions !== (bound?.instructions ?? "");
  const keyValid = KEY_PATTERN.test(fields.key.trim());
  const labelValue = fields.label.trim() || fields.key.trim();
  const canSave =
    canOperate && !busy && keyValid && labelValue.length > 0 && (dirty || bound === undefined);

  const reportFailure = (failureTitle: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const runWork = async (
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

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const specialist: ThreadSpecialist = {
      key: fields.key.trim(),
      label: labelValue,
      ...(fields.instructions.trim() === "" ? {} : { instructions: fields.instructions.trim() }),
      ...(bound?.skills === undefined ? {} : { skills: bound.skills }),
      ...(bound?.mcpServers === undefined ? {} : { mcpServers: bound.mcpServers }),
    };
    const result = await setSpecialist({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, specialist },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not bind specialist", squashAtomCommandFailure(result));
      return;
    }
    setEditing(false);
  };

  const clear = async () => {
    if (!canOperate || busy || bound === undefined) return;
    setBusy(true);
    const result = await setSpecialist({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, specialist: null },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not clear specialist", squashAtomCommandFailure(result));
      return;
    }
    setFields(specialistFields(undefined));
    setEditing(true);
  };

  const stopAndArchive = async () => {
    if (!canOperate || busy || bound === undefined || archived) return;
    setBusy(true);
    if (!threadRuntimeCanArchive(props.shell.runtime)) {
      const stopped = await interruptTurn({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      });
      if (stopped._tag === "Failure" && !isAtomCommandInterrupted(stopped)) {
        setBusy(false);
        reportFailure("Could not stop specialist", squashAtomCommandFailure(stopped));
        return;
      }
    }
    const archivedResult = await archiveThread(threadRef);
    setBusy(false);
    if (archivedResult._tag === "Failure" && !isAtomCommandInterrupted(archivedResult)) {
      reportFailure("Could not archive specialist", squashAtomCommandFailure(archivedResult));
    }
  };

  const restore = async () => {
    if (!canOperate || busy || bound === undefined || !archived) return;
    setBusy(true);
    const result = await unarchiveThread(threadRef);
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not restore specialist", squashAtomCommandFailure(result));
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

  if (props.density !== "full") {
    const bits = [
      bound === undefined ? null : `@${bound.key}`,
      openItems.length > 0 ? `${openItems.length} open` : null,
    ].filter(Boolean);
    if (bits.length === 0) return null;
    return (
      <ThreadDetailsSection
        headingId="thread-details-team-heading"
        title="Team"
        separated
        showHeading={props.density === "compact"}
      >
        <div
          className={cn(THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS, "flex items-center gap-1.5 px-2.5")}
        >
          <UsersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="truncate text-xs text-muted-foreground">{bits.join(" · ")}</span>
        </div>
      </ThreadDetailsSection>
    );
  }

  return (
    <ThreadDetailsSection
      headingId="thread-details-team-heading"
      title="Team"
      separated
      data-thread-agent-team-panel
    >
      <div
        className={cn("flex flex-col gap-2 px-2.5 pb-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <UsersIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "shrink-0")} aria-hidden />
          <div className="min-w-0 flex-1">
            {bound === undefined ? (
              <p className="truncate text-xs text-muted-foreground">No specialist bound</p>
            ) : (
              <p className="truncate text-sm font-medium">
                <span className="font-mono text-muted-foreground">@{bound.key}</span>
                <span className="text-muted-foreground"> · </span>
                {bound.label}
                {archived ? <span className="text-muted-foreground"> · archived</span> : null}
              </p>
            )}
            {bound !== undefined && (skillCount > 0 || mcpCount > 0) ? (
              <p className="text-2xs text-muted-foreground">
                {[
                  skillCount > 0 ? `${skillCount} skill${skillCount === 1 ? "" : "s"}` : null,
                  mcpCount > 0 ? `${mcpCount} MCP` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
          {canOperate ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              disabled={busy}
              onClick={() => {
                setFields(specialistFields(bound));
                setEditing((current) => !current);
              }}
            >
              {editing ? "Close" : bound === undefined ? "Bind" : "Edit"}
            </ThreadDetailsControl>
          ) : null}
        </div>

        {editing ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border/50 p-2">
            <Input
              size="sm"
              font="mono"
              nativeInput
              value={fields.key}
              placeholder="key"
              spellCheck={false}
              autoComplete="off"
              disabled={!canOperate || busy || archived}
              aria-label="Specialist key"
              aria-invalid={fields.key.length > 0 && !keyValid}
              onChange={(event) =>
                setFields((current) => ({ ...current, key: event.target.value }))
              }
            />
            <Input
              size="sm"
              nativeInput
              value={fields.label}
              placeholder="Label"
              disabled={!canOperate || busy || archived}
              aria-label="Specialist label"
              onChange={(event) =>
                setFields((current) => ({ ...current, label: event.target.value }))
              }
            />
            <Textarea
              size="sm"
              rows={2}
              value={fields.instructions}
              placeholder="Role brief…"
              disabled={!canOperate || busy || archived}
              aria-label="Role brief"
              onChange={(event) =>
                setFields((current) => ({ ...current, instructions: event.target.value }))
              }
            />
            <div className="flex flex-wrap gap-1">
              <ThreadDetailsControl
                size="xs"
                variant="outline"
                part="meta"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {bound === undefined ? "Bind" : "Save"}
              </ThreadDetailsControl>
              {bound !== undefined ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  disabled={!canOperate || busy}
                  onClick={() => void clear()}
                >
                  Clear
                </ThreadDetailsControl>
              ) : null}
              {bound !== undefined && !archived ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  tone="muted"
                  disabled={!canOperate || busy}
                  onClick={() => void stopAndArchive()}
                >
                  Archive
                </ThreadDetailsControl>
              ) : null}
              {bound !== undefined && archived ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="outline"
                  part="meta"
                  disabled={!canOperate || busy}
                  onClick={() => void restore()}
                >
                  Restore
                </ThreadDetailsControl>
              ) : null}
            </div>
          </div>
        ) : null}

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
              aria-label="Assign work"
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

        {openItems.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {openItems.map((item) => {
              const waiting = item.status === "on_hold" || item.status === "needs_attention";
              return (
                <li key={item.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {workStatusLabel(item.status)}
                  </span>
                  {canOperate && waiting ? (
                    <ThreadDetailsControl
                      size="xs"
                      variant="ghost"
                      part="meta"
                      disabled={busyItemId !== null}
                      onClick={() =>
                        void runWork(
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
                  {canOperate && !waiting ? (
                    <ThreadDetailsControl
                      size="xs"
                      variant="ghost"
                      part="meta"
                      tone="primary"
                      disabled={busyItemId !== null}
                      onClick={() =>
                        void runWork(
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
                  {canOperate ? (
                    <ThreadDetailsControl
                      size="xs"
                      variant="ghost"
                      part="meta"
                      tone="muted"
                      disabled={busyItemId !== null}
                      onClick={() =>
                        void runWork(
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
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
