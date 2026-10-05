import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  const noun = `${notice.action === "Discarded" ? "draft" : "thread"}${notice.count === 1 ? "" : "s"}`;
  const isArchive = notice.action === "Archived";
  const actionLabel = isArchive
    ? shortcut
      ? `Unarchive (${shortcut})`
      : "Unarchive"
    : shortcut
      ? `${shortcut} to undo`
      : "Undo";

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {notice.action} {notice.count} {noun},{" "}
        <InlineButton onClick={undoLatestThreadAction}>{actionLabel}</InlineButton>
        {isArchive ? ". Any scheduled tasks stay paused." : null}
      </AlertDescription>
    </Alert>
  );
}
