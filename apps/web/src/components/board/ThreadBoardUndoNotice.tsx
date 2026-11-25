import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";
import { Undo2Icon } from "lucide-react";

import {
  threadUndoLabel,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";

// Same copy as the sidebar's undo notice, which the full-screen board hides.
const SHORT_SUMMARY = {
  Settled: msg("{count, plural, =1 {Settled,} other {Settled {count},}}"),
  Snoozed: msg("{count, plural, =1 {Snoozed,} other {Snoozed {count},}}"),
  Unpinned: msg("{count, plural, =1 {Unpinned,} other {Unpinned {count},}}"),
  Archived: msg("{count, plural, =1 {Archived,} other {Archived {count},}}"),
  Discarded: msg("{count, plural, =1 {Discarded,} other {Discarded {count},}}"),
};

/** The latest settle or snooze, with its undo, while the thread undo store holds one. */
export function ThreadBoardUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const m = useMessages();
  if (notice === null) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span>{m(SHORT_SUMMARY[notice.action], { count: notice.count })}</span>
      <Button size="xs" variant="outline" onClick={undoLatestThreadAction}>
        <Undo2Icon aria-hidden />
        {threadUndoLabel(keybindings, m)}
      </Button>
    </div>
  );
}
