import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  dispatchHardwareKeyboardCommand,
  getHardwareKeyboardCommandRegistrationVersion,
} from "./hardwareKeyboardCommands";
import { useThreadJumpShortcuts } from "./threadKeyboardShortcuts";

function threadItem(id: string): ThreadListV2ListItem {
  const thread = { environmentId: "environment-1", id } as unknown as EnvironmentThreadShell;
  return {
    type: "v2-thread",
    key: id,
    item: { thread, variant: "card", snoozed: false, pinned: false, isLast: false, wokeAt: null },
    snoozeWakeLabelText: undefined,
    timeLabel: "",
    snoozePresetMinute: undefined,
    showTrailingDivider: false,
    hasQueuedMessages: false,
    canMoveUp: false,
    canMoveDown: false,
  };
}

function Probe(props: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  useThreadJumpShortcuts(props.items, props.onSelectThread);
  return null;
}

describe("useThreadJumpShortcuts", () => {
  it("registers once and jumps within the latest list", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe items={[threadItem("first")]} onSelectThread={vi.fn()} />));
    const registrationVersion = getHardwareKeyboardCommandRegistrationVersion();

    const onSelectThread = vi.fn();
    for (const id of ["second", "third"]) {
      act(() => root.render(<Probe items={[threadItem(id)]} onSelectThread={onSelectThread} />));
    }

    expect(getHardwareKeyboardCommandRegistrationVersion()).toBe(registrationVersion);
    expect(dispatchHardwareKeyboardCommand("thread.jump.1")).toBe(true);
    expect(onSelectThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "third" }),
    );
    act(() => root.unmount());
  });
});
