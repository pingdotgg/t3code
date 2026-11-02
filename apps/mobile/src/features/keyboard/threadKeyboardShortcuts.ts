import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  registerHardwareKeyboardCommand,
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
    const thread = item.type === "v2-thread" ? item.item.thread : null;
    if (thread !== null && index-- === 0) return thread;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
) {
  const jumpToThread = useEffectEvent((command: HardwareKeyboardCommand) => {
    const thread = threadJumpTarget(items, command);
    if (thread !== null) onSelectThread(thread);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the jump handlers in the module-level hardware keyboard command registry
  useEffect(
    () =>
      registerHardwareKeyboardCommand(THREAD_JUMP_KEYBINDING_COMMANDS, (command) => {
        jumpToThread(command);
        return true;
      }),
    [],
  );
}
