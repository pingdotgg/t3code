import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m, type MessageResolver } from "../i18n/messages";
import { shortcutLabelForCommand } from "../keybindings";
import { announce, cancelAnnouncement } from "../lib/announce";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

type UndoOptions = {
  action: "Settled" | "Snoozed" | "Rescheduled" | "Unpinned" | "Archived" | "Discarded";
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
  commit?: () => void;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  undo: () => Promise<void>;
};

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

const SUMMARY = {
  Settled: msg("Settled {count, plural, one {{count} thread} other {{count} threads}}"),
  Snoozed: msg("Snoozed {count, plural, one {{count} thread} other {{count} threads}}"),
  Rescheduled: msg("Rescheduled {count, plural, one {{count} thread} other {{count} threads}}"),
  Unpinned: msg("Unpinned {count, plural, one {{count} thread} other {{count} threads}}"),
  Archived: msg("Archived {count, plural, one {{count} thread} other {{count} threads}}"),
  Discarded: msg("Discarded {count, plural, one {{count} draft} other {{count} drafts}}"),
} satisfies Record<UndoOptions["action"], string>;

const UNDONE = {
  Settled: msg("Undid settle of {count, plural, one {{count} thread} other {{count} threads}}"),
  Snoozed: msg("Undid snooze of {count, plural, one {{count} thread} other {{count} threads}}"),
  Rescheduled: msg(
    "Undid reschedule of {count, plural, one {{count} thread} other {{count} threads}}",
  ),
  Unpinned: msg("Undid unpin of {count, plural, one {{count} thread} other {{count} threads}}"),
  Archived: msg("Undid archive of {count, plural, one {{count} thread} other {{count} threads}}"),
  Discarded: msg("Undid discard of {count, plural, one {{count} draft} other {{count} drafts}}"),
} satisfies Record<UndoOptions["action"], string>;

function threadUndoNoticeSummary(notice: Pick<UndoNotice, "action" | "count">): string {
  return m(SUMMARY[notice.action], { count: notice.count });
}

/** Components pass `useMessages()` so the label follows a language switch. */
export function threadUndoLabel(
  keybindings: Parameters<typeof shortcutLabelForCommand>[0],
  resolve: MessageResolver = m,
) {
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  return shortcut ? resolve(msg("{shortcut} to undo", { shortcut })) : resolve(msg("Undo"));
}

let announcedSummary: string | null = null;

// A live region that mounts already filled is skipped by screen readers, and settling
// usually moves focus to the next thread at the same moment, so the notice is announced
// separately from the alert that shows it.
function setNotice(notice: UndoNotice | null) {
  useThreadUndoNotice.setState({ notice });
  const summary = notice ? threadUndoNoticeSummary(notice) : null;
  if (summary === announcedSummary) return;
  announcedSummary = summary;
  if (summary) {
    const label = threadUndoLabel(appAtomRegistry.get(primaryServerKeybindingsAtom));
    announce(m(msg("{summary}, {label}", { summary, label })), "thread-undo-notice");
  } else {
    cancelAnnouncement("thread-undo-notice");
  }
}

let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
// A new notice owns mod+z even inside a text field, until the user presses
// another key or edits text. After that, mod+z is the field's own undo again.
let shortcutClaimed = false;

function refreshNotice() {
  const stale = liveUndos.filter(({ claim }) => !claim.isCurrent());
  liveUndos = liveUndos.filter((entry) => !stale.includes(entry));
  for (const entry of stale) entry.commit?.();
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    setNotice(null);
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  setNotice({
    action: latest.action,
    count: group.length,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      // Claim before awaiting to prevent repeated actions restoring a group twice.
      for (const entry of current) entry.claim.finish();
      refreshNotice();
      let undone = 0;
      await Promise.all(
        current.map(async ({ undo, failureTitle }) => {
          const reportFailure = (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: failureTitle,
                description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
              }),
            );
          };
          try {
            const result = await undo();
            if (result._tag === "Success") undone++;
            else if (!isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        }),
      );
      // Failures already raise a toast, so only what was actually restored is spoken.
      if (undone > 0) {
        announce(m(UNDONE[latest.action], { count: undone }));
      }
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Whether mod+z should undo the notice's actions even while a text field is focused. */
export function threadUndoClaimsShortcut(): boolean {
  return shortcutClaimed && useThreadUndoNotice.getState().notice !== null;
}

/** Called on any other keypress or text edit; hands mod+z back to text fields. */
export function releaseThreadUndoShortcut() {
  shortcutClaimed = false;
}

/** Shows one compact confirmation for the currently undoable thread actions. */
export function showThreadUndoNotice(options: UndoOptions) {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  shortcutClaimed = true;
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim, commit } of expired) {
      claim.finish();
      commit?.();
    }
    refreshNotice();
  }, 5_000);
}
