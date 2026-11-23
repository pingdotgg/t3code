import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import type { PendingNewTask } from "../../state/pending-new-tasks-model";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

type ThreadShortcutListItem = ThreadListV2ListItem | { readonly type: "v2-show-more" };

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

export function threadJumpTarget(
  items: ReadonlyArray<ThreadShortcutListItem>,
  command: HardwareKeyboardCommand,
) {
  let index = threadJumpIndex(command);
  if (index < 0) return null;
  for (const item of items) {
    if (item.type !== "v2-thread" && item.type !== "v2-pending") continue;
    if (index-- === 0) return item;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
  onSelectPendingTask: (pendingTask: PendingNewTask) => void,
) {
  const jumpToThread = (command: HardwareKeyboardCommand) => {
    const target = threadJumpTarget(items, command);
    if (target?.type === "v2-thread") onSelectThread(target.item.thread);
    if (target?.type === "v2-pending") onSelectPendingTask(target.pendingTask);
    return true;
  };
  useHardwareKeyboardCommand(THREAD_JUMP_KEYBINDING_COMMANDS, jumpToThread);
}
