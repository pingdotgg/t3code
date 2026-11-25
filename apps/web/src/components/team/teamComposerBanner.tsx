import type { TeamThreadPostPermission } from "@t3tools/client-runtime/team";
import { msg } from "gt-react";
import { EyeIcon, LockIcon } from "lucide-react";

import type { MessageResolver } from "~/i18n/messages";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";

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
