import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");

  return (
    <Alert
      role="status"
      className="rounded-lg border-sidebar-border bg-sidebar-control-surface px-2 py-1.5 dark:bg-sidebar-control-surface"
    >
      <AlertDescription className="block text-[11px] leading-4 text-sidebar-muted-foreground">
        {notice.action} {notice.count} thread{notice.count === 1 ? "" : "s"},{" "}
        <Button
          variant="link"
          size="micro"
          onClick={undoLatestThreadAction}
          className="h-auto border-0 p-0 font-normal hover:text-sidebar-foreground"
        >
          {shortcut ? `${shortcut} to undo` : "Undo"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
