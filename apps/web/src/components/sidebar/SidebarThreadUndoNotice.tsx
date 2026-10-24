import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { announce, cancelAnnouncement } from "../../lib/announce";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  const undoLabel = shortcut ? `${shortcut} to undo` : "Undo";
  const summary = notice
    ? `${notice.action} ${notice.count} ${notice.action === "Discarded" ? "draft" : "thread"}${notice.count === 1 ? "" : "s"}`
    : null;

  // A live region that mounts already filled is skipped by screen readers, and settling
  // usually moves focus to the next thread at the same moment.
  useEffect(() => {
    if (summary) announce(`${summary}, ${undoLabel}`, "thread-undo-notice");
    else cancelAnnouncement("thread-undo-notice");
  }, [summary, undoLabel]);

  if (!summary) return null;

  return (
    <Alert role="group" variant="sidebar">
      <AlertDescription>
        {summary}, <InlineButton onClick={undoLatestThreadAction}>{undoLabel}</InlineButton>
      </AlertDescription>
    </Alert>
  );
}
