import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  effectiveTeamThreadNoteBody,
  effectiveTeamThreadNoteHash,
  requiresTeamNoteApprovalConfirmation,
  type EnvironmentId,
  type TeamMember,
  type TeamThreadNote,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TeamNoteConfirmDialog } from "./TeamNoteConfirmDialog";

type PendingConfirmation =
  | { readonly kind: "accept"; readonly text: string }
  | { readonly kind: "accept_and_send"; readonly text: string }
  | { readonly kind: "edit"; readonly text: string };

export function TeamThreadNoteCard({
  note,
  teamEnvironmentId,
  currentMember,
  canResolveNotes,
  isComposerEmpty,
  isThreadRunning,
  onDispatchAcceptedNote,
}: {
  readonly note: TeamThreadNote;
  readonly teamEnvironmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly canResolveNotes: boolean;
  readonly isComposerEmpty: boolean;
  readonly isThreadRunning: boolean;
  readonly onDispatchAcceptedNote?: (input: {
    readonly note: TeamThreadNote;
    readonly queueBehindActive: boolean;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const resolveNote = useAtomCommand(teamEnvironment.resolveThreadNote, { reportFailure: false });
  const editNote = useAtomCommand(teamEnvironment.editThreadNote, { reportFailure: false });
  const deleteNote = useAtomCommand(teamEnvironment.deleteThreadNote, { reportFailure: false });

  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [rejectedExpanded, setRejectedExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);

  const effectiveBody = effectiveTeamThreadNoteBody(note);
  const isAuthor = currentMember !== null && currentMember.id === note.authorMemberId;
  const canAuthorDelete = isAuthor && note.status === "pending";
  const needsConfirmation = requiresTeamNoteApprovalConfirmation(note.authorRole);
  const isRejected = note.status === "rejected";
  const isConsumed = note.status === "consumed";
  const isEdited = note.editedBody !== null;

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const runResolve = async (
    status: "pending" | "accepted" | "rejected",
    expectedContentHash?: string,
  ): Promise<TeamThreadNote | null> => {
    setBusy(true);
    const result = await resolveNote({
      environmentId: teamEnvironmentId,
      input: {
        noteId: note.id,
        status,
        ...(expectedContentHash ? { expectedContentHash } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      return result.value;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not update note"), squashAtomCommandFailure(result));
    }
    return null;
  };

  const executeAccept = async (sendImmediately: boolean) => {
    const updated = await runResolve("accepted", effectiveTeamThreadNoteHash(note));
    if (!updated) return;
    if ((sendImmediately || isThreadRunning) && onDispatchAcceptedNote) {
      setBusy(true);
      await onDispatchAcceptedNote({
        note: updated,
        queueBehindActive: isThreadRunning,
      }).finally(() => {
        setBusy(false);
      });
    }
  };

  const executeEditSave = async (nextBody: string) => {
    setBusy(true);
    const result = await editNote({
      environmentId: teamEnvironmentId,
      input: {
        noteId: note.id,
        editedBody: nextBody,
        status: "accepted",
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setEditing(false);
      if (isThreadRunning && onDispatchAcceptedNote) {
        setBusy(true);
        await onDispatchAcceptedNote({
          note: result.value,
          queueBehindActive: true,
        }).finally(() => {
          setBusy(false);
        });
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not edit note"), squashAtomCommandFailure(result));
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    const result = await deleteNote({
      environmentId: teamEnvironmentId,
      input: { noteId: note.id },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportError(gt("Could not delete note"), squashAtomCommandFailure(result));
    }
  };

  const handleAcceptClick = (sendImmediately: boolean) => {
    if (needsConfirmation) {
      setConfirmation({
        kind: sendImmediately ? "accept_and_send" : "accept",
        text: effectiveBody,
      });
      return;
    }
    void executeAccept(sendImmediately);
  };

  const handleEditSubmit = () => {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    if (needsConfirmation) {
      setConfirmation({ kind: "edit", text: trimmed });
      return;
    }
    void executeEditSave(trimmed);
  };

  const handleConfirmDialog = async () => {
    if (!confirmation) return;
    const action = confirmation;
    setConfirmation(null);
    if (action.kind === "accept") {
      await executeAccept(false);
    } else if (action.kind === "accept_and_send") {
      await executeAccept(true);
    } else {
      await executeEditSave(action.text);
    }
  };

  const headerLabel =
    isEdited && note.resolvedByPseudo
      ? gt("Note from {author} (edited by {editor}):", {
          author: note.authorPseudo,
          editor: note.resolvedByPseudo,
        })
      : gt("Note from {author}:", { author: note.authorPseudo });

  const statusBadge =
    note.status === "pending" ? (
      <Badge variant="warning" size="sm" data-testid={`team-note-status-${note.id}`}>
        <T>Pending</T>
      </Badge>
    ) : note.status === "accepted" ? (
      <Badge variant="success" size="sm" data-testid={`team-note-status-${note.id}`}>
        <T>Accepted</T>
      </Badge>
    ) : note.status === "consumed" ? (
      <Badge variant="secondary" size="sm" data-testid={`team-note-status-${note.id}`}>
        <T>Included</T>
      </Badge>
    ) : (
      <Badge variant="outline" size="sm" data-testid={`team-note-status-${note.id}`}>
        <T>Rejected</T>
      </Badge>
    );

  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane">
        <div
          data-testid={`team-thread-note-${note.id}`}
          data-team-note-status={note.status}
          className={cn(
            "rounded-xl border px-3.5 py-2.5 text-sm transition-colors",
            note.status === "pending"
              ? "border-warning/50 bg-warning-surface/40"
              : note.status === "accepted"
                ? "border-success/45 bg-success/10"
                : note.status === "rejected"
                  ? "border-border/50 bg-muted/25 opacity-70"
                  : "border-border/60 bg-muted/30",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
              {isRejected ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setRejectedExpanded((prev) => !prev)}
                  data-testid={`team-note-toggle-rejected-${note.id}`}
                >
                  {rejectedExpanded ? (
                    <ChevronDownIcon className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronRightIcon className="size-3.5" aria-hidden />
                  )}
                  <StickyNoteIcon className="size-3.5 shrink-0" aria-hidden />
                  <span>{headerLabel}</span>
                </button>
              ) : (
                <>
                  <StickyNoteIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{headerLabel}</span>
                </>
              )}
              {statusBadge}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {canAuthorDelete ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  data-testid={`team-note-delete-${note.id}`}
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon />
                  <T>Delete</T>
                </Button>
              ) : null}

              {canResolveNotes && !isConsumed && !editing ? (
                <>
                  {note.status === "pending" ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        data-testid={`team-note-accept-${note.id}`}
                        onClick={() => handleAcceptClick(false)}
                      >
                        {busy ? <Spinner size="xs" /> : <CheckIcon />}
                        {isThreadRunning ? <T>Accept & Queue</T> : <T>Accept</T>}
                      </Button>
                      {isComposerEmpty && !isThreadRunning && onDispatchAcceptedNote ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          disabled={busy}
                          data-testid={`team-note-accept-send-${note.id}`}
                          onClick={() => handleAcceptClick(true)}
                        >
                          <SendIcon />
                          <T>Accept & Send</T>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-edit-${note.id}`}
                        onClick={() => {
                          setEditDraft(effectiveBody);
                          setEditing(true);
                        }}
                      >
                        <PencilIcon />
                        <T>Edit</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-reject-${note.id}`}
                        onClick={() => void runResolve("rejected")}
                      >
                        <XIcon />
                        <T>Reject</T>
                      </Button>
                    </>
                  ) : note.status === "accepted" ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-edit-${note.id}`}
                        onClick={() => {
                          setEditDraft(effectiveBody);
                          setEditing(true);
                        }}
                      >
                        <PencilIcon />
                        <T>Edit</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-unaccept-${note.id}`}
                        onClick={() => void runResolve("pending")}
                      >
                        <RotateCcwIcon />
                        <T>Undo</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-reject-${note.id}`}
                        onClick={() => void runResolve("rejected")}
                      >
                        <XIcon />
                        <T>Reject</T>
                      </Button>
                    </>
                  ) : note.status === "rejected" ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`team-note-restore-${note.id}`}
                        onClick={() => void runResolve("pending")}
                      >
                        <RotateCcwIcon />
                        <T>Restore</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        data-testid={`team-note-accept-${note.id}`}
                        onClick={() => handleAcceptClick(false)}
                      >
                        <CheckIcon />
                        <T>Accept</T>
                      </Button>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          {editing ? (
            <div className="mt-2 space-y-2" data-testid={`team-note-edit-form-${note.id}`}>
              <Textarea
                value={editDraft}
                onChange={(event) => setEditDraft(event.currentTarget.value)}
                rows={3}
                data-testid={`team-note-edit-input-${note.id}`}
              />
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  disabled={busy || editDraft.trim().length === 0}
                  data-testid={`team-note-edit-save-${note.id}`}
                  onClick={handleEditSubmit}
                >
                  {busy ? <Spinner size="xs" /> : <CheckIcon />}
                  <T>Save & Accept</T>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          ) : !isRejected || rejectedExpanded ? (
            <div className="mt-1.5 space-y-1">
              <p
                data-testid={`team-note-body-${note.id}`}
                className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
              >
                {effectiveBody}
              </p>
              {isEdited ? (
                <div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setShowOriginal((prev) => !prev)}
                  >
                    {showOriginal ? gt("Hide original note") : gt("Show original note")}
                  </button>
                  {showOriginal ? (
                    <p
                      data-testid={`team-note-original-body-${note.id}`}
                      className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
                    >
                      {note.originalBody}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <TeamNoteConfirmDialog
        open={confirmation !== null}
        authorPseudo={note.authorPseudo}
        exactText={confirmation?.text ?? effectiveBody}
        actionLabel={
          confirmation?.kind === "accept_and_send"
            ? gt("Confirm & Send")
            : isThreadRunning
              ? gt("Confirm & Queue")
              : gt("Confirm & Accept")
        }
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void handleConfirmDialog()}
      />
    </div>
  );
}
