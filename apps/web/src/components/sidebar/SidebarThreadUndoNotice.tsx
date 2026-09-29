import { translate } from "@t3tools/i18n";
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
  const actionKey = {
    Settled: "common:uiSettledThreadAction",
    Snoozed: "common:uiSnoozedThreadAction",
    Unpinned: "common:uiUnpinnedThreadAction",
    Archived: "common:uiArchivedThreadAction",
  }[notice.action];
  const action = translate(actionKey, notice.action);
  const description = translate(
    notice.count === 1 ? "common:uiThreadUndoNoticeOne" : "common:uiThreadUndoNoticeMany",
    notice.count === 1 ? "{{action}} {{count}} thread," : "{{action}} {{count}} threads,",
    { action, count: notice.count },
  );

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {description}{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut
            ? translate("common:uiShortcutToUndo", "{{shortcut}} to undo", { shortcut })
            : translate("common:uiUndo", "Undo")}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
