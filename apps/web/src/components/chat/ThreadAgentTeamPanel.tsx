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
import { EllipsisIcon, ListTodoIcon, PlusIcon, UserRoundIcon } from "lucide-react";
import { useId, useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { cn, randomUUID } from "../../lib/utils";
import { useQuietThreadProjection, useThreadShell } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const WORK_STATUS_DOT_CLASS: Record<OwnedWorkItem["status"], string> = {
  assigned: "bg-info",
  claimed: "bg-info",
  in_progress: "bg-warning",
  on_hold: "bg-muted-foreground/50",
  needs_attention: "bg-destructive",
  handed_off: "bg-update",
  completed: "bg-success",
  cancelled: "bg-muted-foreground/40",
};

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
      return "Needs attention";
    case "handed_off":
      return "Handed off";
    case "completed":
      return "Done";
    case "cancelled":
      return "Canceled";
  }
}

/** Secondary line: status plus who the item is waiting on / owned by, for this viewer. */
function workStatusDetail(item: OwnedWorkItem, viewerThreadId: ThreadId): string {
  const status = workStatusLabel(item.status);
  if (item.status === "assigned") {
    if (item.assigneeThreadId === null) return `${status} · open to claim`;
    if (item.assigneeThreadId === viewerThreadId) return `${status} · for this seat`;
    return `${status} · for another seat`;
  }
  if (item.status === "handed_off") {
    if (item.assigneeThreadId === null) return `${status} · open to claim`;
    if (item.assigneeThreadId === viewerThreadId) return `${status} · for this seat`;
    return `${status} · for another seat`;
  }
  if (item.claimedByThreadId === viewerThreadId) return `${status} · claimed here`;
  if (item.claimedByThreadId !== null) return `${status} · claimed elsewhere`;
  return status;
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

function seatMeta(bound: ThreadSpecialist, archived: boolean) {
  const skillCount = bound.skills?.length ?? 0;
  const mcpCount = specialistMcpServerEntries(bound).length;
  return [
    archived ? "Archived" : null,
    skillCount > 0 ? `${skillCount} skill${skillCount === 1 ? "" : "s"}` : null,
    mcpCount > 0 ? `${mcpCount} MCP` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Labs Agent Teams in Thread Details folds two concepts into one section:
 * - Specialist: durable @key role binding for this thread (the seat)
 * - Work: owned-work board living on this thread (assign → claim → close)
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
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);

  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState(() => specialistFields(bound));
  const [busy, setBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const assignTitleId = useId();
  const assignDescriptionId = useId();
  const assignFormId = useId();

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
  const claim = useOrchestrationCommand(threadEnvironment.claimOwnedWork, {
    label: "claim owned work",
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
    canOperate &&
    !busy &&
    !archived &&
    keyValid &&
    labelValue.length > 0 &&
    (dirty || bound === undefined);

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
      archived ||
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

  const beginEdit = () => {
    setFields(specialistFields(bound));
    setEditing(true);
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
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not bind specialist", squashAtomCommandFailure(result));
      }
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
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not clear specialist", squashAtomCommandFailure(result));
      }
      return;
    }
    setFields(specialistFields(undefined));
    setEditing(false);
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

  const openAssign = () => {
    setTitle("");
    setDescription("");
    setAssignOpen(true);
  };

  const onAssign = async () => {
    const trimmed = title.trim();
    if (trimmed === "" || busyItemId !== null || archived) return;
    if (!readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)) return;
    const itemId = OwnedWorkItemId.make(`owned-work:${randomUUID()}`);
    const trimmedDescription = description.trim();
    setBusyItemId(itemId);
    const result = await assign({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        itemId,
        title: trimmed,
        ...(trimmedDescription === "" ? {} : { description: trimmedDescription }),
        createdByThreadId: props.threadId,
      },
    });
    setBusyItemId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not assign work", squashAtomCommandFailure(result));
      return;
    }
    setTitle("");
    setDescription("");
    setAssignOpen(false);
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
          <UserRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="truncate text-xs text-muted-foreground">{bits.join(" · ")}</span>
        </div>
      </ThreadDetailsSection>
    );
  }

  const meta = bound === undefined ? null : seatMeta(bound, archived);
  const workBusy = busyItemId !== null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-team-heading"
      title="Team"
      separated
      data-thread-agent-team-panel
      actions={
        canOperate && !archived ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  disabled={busy || workBusy}
                  aria-label="Assign work"
                  onClick={openAssign}
                >
                  <PlusIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Assign work</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
        {bound === undefined && !editing ? (
          <li>
            {canOperate && !archived ? (
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                disabled={busy}
                onClick={beginEdit}
              >
                <UserRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                <span className="truncate text-sm font-medium text-foreground/80">
                  Bind specialist
                </span>
              </ThreadDetailsControl>
            ) : (
              <div
                className={cn(
                  "flex min-w-0 items-center rounded-lg py-1.5",
                  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                )}
              >
                <UserRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                <span className="truncate text-sm text-muted-foreground">No specialist</span>
              </div>
            )}
          </li>
        ) : (
          <li
            className={cn(
              "flex min-w-0 items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <UserRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <div className="min-w-0 flex-1">
              {bound === undefined ? (
                <p className="truncate text-sm font-medium text-foreground/80">New specialist</p>
              ) : (
                <>
                  <p className="truncate text-sm font-medium text-foreground/80">
                    <span className="font-mono text-muted-foreground">@{bound.key}</span>
                    <span className="text-muted-foreground"> · </span>
                    {bound.label}
                  </p>
                  {meta !== null && meta.length > 0 ? (
                    <p className="truncate text-2xs text-muted-foreground">{meta}</p>
                  ) : null}
                </>
              )}
            </div>
            {canOperate && editing ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                disabled={busy}
                onClick={() => {
                  setFields(specialistFields(bound));
                  setEditing(false);
                }}
              >
                Cancel
              </ThreadDetailsControl>
            ) : null}
            {canOperate && bound !== undefined && !editing ? (
              <>
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  disabled={busy || archived}
                  onClick={beginEdit}
                >
                  Edit
                </ThreadDetailsControl>
                <Menu>
                  <MenuTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        disabled={busy}
                        aria-label="Specialist seat actions"
                      >
                        <EllipsisIcon className="size-3.5" />
                      </ThreadDetailsControl>
                    }
                  />
                  <MenuPopup align="end" className="min-w-40">
                    {archived ? (
                      <MenuItem disabled={busy} onClick={() => void restore()}>
                        Restore
                      </MenuItem>
                    ) : (
                      <MenuItem disabled={busy} onClick={() => void stopAndArchive()}>
                        Archive
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem disabled={busy} variant="destructive" onClick={() => void clear()}>
                      Clear binding
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </>
            ) : null}
          </li>
        )}

        {editing ? (
          <li className="flex flex-col gap-1.5 px-2.5 pb-1">
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
            <div className="flex justify-end gap-1">
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {bound === undefined ? "Bind" : "Save"}
              </ThreadDetailsControl>
            </div>
          </li>
        ) : null}

        {openItems.map((item) => {
          const waiting = item.status === "on_hold" || item.status === "needs_attention";
          const claimable =
            item.status === "assigned" || item.status === "handed_off"
              ? item.assigneeThreadId === null || item.assigneeThreadId === props.threadId
              : false;
          const ownsActive =
            item.claimedByThreadId === props.threadId &&
            (item.status === "claimed" ||
              item.status === "in_progress" ||
              item.status === "on_hold" ||
              item.status === "needs_attention");
          const canCancel =
            item.createdByThreadId === props.threadId || item.claimedByThreadId === props.threadId;
          const itemBusy = busyItemId === item.id;
          return (
            <li
              key={item.id}
              className={cn(
                "flex min-w-0 items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <ListTodoIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                <span
                  className={cn(
                    "absolute -right-1 -top-1 size-1.5 rounded-full",
                    WORK_STATUS_DOT_CLASS[item.status],
                  )}
                  aria-hidden
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground/80">{item.title}</p>
                <p className="truncate text-2xs text-muted-foreground">
                  {workStatusDetail(item, props.threadId)}
                </p>
              </div>
              {canOperate && !archived && waiting && ownsActive ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  disabled={workBusy}
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
              {canOperate && !archived && claimable ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  disabled={workBusy}
                  onClick={() =>
                    void runWork(
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
              {canOperate && !archived && ownsActive && !waiting ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  disabled={workBusy}
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
              {canOperate && !archived && canCancel ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        disabled={workBusy}
                        aria-label={`${item.title} actions`}
                      >
                        <EllipsisIcon className="size-3.5" />
                      </ThreadDetailsControl>
                    }
                  />
                  <MenuPopup align="end" className="min-w-36">
                    <MenuItem
                      disabled={itemBusy}
                      variant="destructive"
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
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={assignOpen}
        onOpenChange={(open) => {
          if (workBusy) return;
          setAssignOpen(open);
          if (!open) {
            setTitle("");
            setDescription("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign work</DialogTitle>
            <DialogDescription>
              Add an item to this thread’s work board. Teammates claim it from their seat.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id={assignFormId}
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void onAssign();
              }}
            >
              <label htmlFor={assignTitleId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Title</span>
                <Input
                  id={assignTitleId}
                  size="sm"
                  nativeInput
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What needs doing?"
                  disabled={workBusy}
                  autoComplete="off"
                />
              </label>
              <label htmlFor={assignDescriptionId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  Notes <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <Textarea
                  id={assignDescriptionId}
                  size="sm"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Context, links, acceptance criteria…"
                  disabled={workBusy}
                />
              </label>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={workBusy}
              onClick={() => setAssignOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-slot="dialog-action"
              type="submit"
              form={assignFormId}
              disabled={workBusy || title.trim() === ""}
            >
              {workBusy ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ThreadDetailsSection>
  );
}
