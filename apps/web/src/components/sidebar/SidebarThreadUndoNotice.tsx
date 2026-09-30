import { useAtomValue } from "@effect/atom-react";

import {
  setThreadUndoNoticeHeld,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
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
    <Alert
      role="status"
      variant="sidebar"
      onPointerEnter={() => setThreadUndoNoticeHeld(true)}
      onPointerLeave={() => setThreadUndoNoticeHeld(false)}
    >
      <AlertDescription>
        {notice.action} {notice.count} thread{notice.count === 1 ? "" : "s"},{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? `${shortcut} to undo` : "Undo"}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
