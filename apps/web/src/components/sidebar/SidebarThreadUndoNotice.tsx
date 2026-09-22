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

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {notice.action} {notice.count} thread{notice.count === 1 ? "" : "s"},{" "}
        <InlineButton
          underline
          onClick={undoLatestThreadAction}
          className="hover:text-sidebar-foreground"
        >
          {shortcut ? `${shortcut} to undo` : "Undo"}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
