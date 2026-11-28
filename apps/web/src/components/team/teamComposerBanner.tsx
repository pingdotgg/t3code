import type { TeamThreadPostPermission } from "@t3tools/client-runtime/team";
import type { TeamThreadEnvironmentAccess, TeamThreadNote } from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  AlertCircleIcon,
  EyeIcon,
  GitForkIcon,
  LaptopIcon,
  LockIcon,
  MonitorOffIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";

import type { MessageResolver } from "~/i18n/messages";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

export function formatTeamThreadPostBlockReason(
  blockReason: TeamThreadPostPermission["blockReason"],
  resolve: MessageResolver,
): string | null {
  switch (blockReason) {
    case "locked":
      return resolve(msg("This thread is locked. Only team owners and admins can post."));
    case "view_read_only":
      return resolve(
        msg("This view is read-only for your role. You cannot post in colleagues' threads here."),
      );
    case "no_access":
      return resolve(msg("You do not have permission to post in this thread."));
    default:
      return null;
  }
}

export function formatTeamThreadEnvBlockReason(
  envAccess: TeamThreadEnvironmentAccess,
  ownerPseudo: string | null,
  resolve: MessageResolver,
  options?: { readonly canOpenLocalThread?: boolean },
): string | null {
  if (envAccess.canExecute) return null;
  if (envAccess.reason === "own_local_mirror") {
    return options?.canOpenLocalThread
      ? resolve(
          msg(
            "This thread runs on your local environment ({environment}). Open the live local thread to continue sending messages.",
            { environment: envAccess.environmentLabel },
          ),
        )
      : resolve(
          msg(
            "This thread runs on your local environment ({environment}), which is not connected here. Open it on that machine or fork it to an accessible environment.",
            { environment: envAccess.environmentLabel },
          ),
        );
  }
  if (envAccess.reason === "other_member_local") {
    return ownerPseudo
      ? resolve(
          msg(
            "This thread runs exclusively on {owner}'s local machine. Fork it to an accessible environment or leave a note instead.",
            { owner: ownerPseudo },
          ),
        )
      : resolve(
          msg(
            "This thread runs on its owner's local machine. Fork it to an accessible environment or leave a note instead.",
          ),
        );
  }
  return resolve(
    msg(
      "Your role does not have execution access to this thread's environment. Fork it to an accessible environment or leave a note instead.",
    ),
  );
}

export function teamReadOnlyComposerBannerItem(
  permission: TeamThreadPostPermission,
  resolve: MessageResolver,
): ComposerBannerStackItem | null {
  if (permission.canPost || permission.blockReason === null) return null;
  const isLocked = permission.blockReason === "locked";
  const reason = formatTeamThreadPostBlockReason(permission.blockReason, resolve);
  if (reason === null) return null;
  return {
    id: "team-read-only",
    variant: isLocked ? "warning" : "info",
    icon: isLocked ? (
      <LockIcon aria-hidden className="size-3.5" />
    ) : (
      <EyeIcon aria-hidden className="size-3.5" />
    ),
    title: (
      <span data-testid="team-composer-readonly-banner" data-reason={permission.blockReason}>
        {isLocked ? resolve(msg("Thread locked")) : resolve(msg("Read-only view"))}
      </span>
    ),
    description: reason,
  };
}

export function teamInaccessibleEnvironmentBannerItem(input: {
  readonly envAccess: TeamThreadEnvironmentAccess;
  readonly ownerPseudo: string | null;
  readonly environmentLabel: string | null;
  readonly canLeaveNote: boolean;
  readonly onOpenLocalThread?: () => void;
  readonly onForkThread: () => void;
  readonly onEnterNoteMode: () => void;
  readonly resolve: MessageResolver;
}): ComposerBannerStackItem | null {
  const {
    envAccess,
    ownerPseudo,
    environmentLabel,
    canLeaveNote,
    onOpenLocalThread,
    onForkThread,
    onEnterNoteMode,
    resolve,
  } = input;
  if (envAccess.canExecute) return null;

  const isOwnLocalMirror = envAccess.reason === "own_local_mirror";
  const canOpenLocalThread = isOwnLocalMirror && onOpenLocalThread !== undefined;

  const title = isOwnLocalMirror
    ? resolve(msg("Viewing mirrored copy of your local thread"))
    : envAccess.reason === "other_member_local"
      ? ownerPseudo
        ? resolve(msg("Running on {owner}'s local environment", { owner: ownerPseudo }))
        : resolve(msg("Running on owner's local environment"))
      : environmentLabel
        ? resolve(msg("Environment restricted ({environment})", { environment: environmentLabel }))
        : resolve(msg("Environment restricted"));

  const description = formatTeamThreadEnvBlockReason(envAccess, ownerPseudo, resolve, {
    canOpenLocalThread,
  });

  return {
    id: "team-inaccessible-environment",
    variant: isOwnLocalMirror ? "info" : "warning",
    icon: isOwnLocalMirror ? (
      <LaptopIcon aria-hidden className="size-3.5" />
    ) : (
      <MonitorOffIcon aria-hidden className="size-3.5" />
    ),
    title: (
      <span data-testid="team-inaccessible-env-banner" data-reason={envAccess.reason}>
        {title}
      </span>
    ),
    description,
    actions: (
      <div className="flex flex-wrap items-center gap-1.5">
        {canOpenLocalThread ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            data-testid="team-open-local-thread-button"
            onClick={onOpenLocalThread}
          >
            <LaptopIcon />
            {resolve(msg("Open local thread"))}
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="team-fork-thread-button"
          onClick={onForkThread}
        >
          <GitForkIcon />
          {resolve(msg("Fork this thread"))}
        </Button>
        {canLeaveNote ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            data-testid="team-leave-note-button"
            onClick={onEnterNoteMode}
          >
            <StickyNoteIcon />
            {resolve(msg("Leave a note"))}
          </Button>
        ) : null}
      </div>
    ),
  };
}

export function teamNoteModeComposerBannerItem(input: {
  readonly ownerPseudo: string | null;
  readonly onCancel: () => void;
  readonly resolve: MessageResolver;
}): ComposerBannerStackItem {
  const { ownerPseudo, onCancel, resolve } = input;
  return {
    id: "team-note-mode",
    variant: "info",
    icon: <StickyNoteIcon aria-hidden className="size-3.5" />,
    title: (
      <span data-testid="team-note-mode-banner">
        {ownerPseudo
          ? resolve(msg("Note mode: leave a note for {owner}", { owner: ownerPseudo }))
          : resolve(msg("Note mode: leave a note for the thread owner"))}
      </span>
    ),
    description: resolve(
      msg("Notes are shown in the timeline and only sent to the agent if the owner accepts them."),
    ),
    actions: (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        data-testid="team-note-mode-cancel"
        onClick={onCancel}
      >
        <XIcon />
        {resolve(msg("Cancel"))}
      </Button>
    ),
  };
}

export function teamPendingNotesComposerBannerItem(input: {
  readonly pendingNotes: ReadonlyArray<TeamThreadNote>;
  readonly resolve: MessageResolver;
}): ComposerBannerStackItem | null {
  const { pendingNotes, resolve } = input;
  if (pendingNotes.length === 0) return null;
  const authors = [...new Set(pendingNotes.map((note) => note.authorPseudo))].join(", ");
  return {
    id: "team-pending-notes",
    variant: "warning",
    icon: <AlertCircleIcon aria-hidden className="size-3.5" />,
    title: (
      <span data-testid="team-pending-notes-bar" data-pending-count={pendingNotes.length}>
        {pendingNotes.length === 1
          ? resolve(
              msg("1 pending note from {authors}. Accept or reject before sending.", { authors }),
            )
          : resolve(
              msg("{count} pending notes from {authors}. Accept or reject before sending.", {
                count: pendingNotes.length,
                authors,
              }),
            )}
      </span>
    ),
  };
}
