import { useAtomValue } from "@effect/atom-react";

import {
  threadUndoLabel,
  threadUndoNoticeSummary,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;

  return (
    <Alert role="group" variant="sidebar">
      <AlertDescription>
        {threadUndoNoticeSummary(notice)},{" "}
        <InlineButton onClick={undoLatestThreadAction}>{threadUndoLabel(keybindings)}</InlineButton>
      </AlertDescription>
    </Alert>
  );
}
