import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CHAT_REPLIES_DISPLAY_MODE,
  type DisplayMode,
  NORMAL_DISPLAY_MODE,
} from "@t3tools/shared/displayModes";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../../components/threadActionMenu.logic";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import {
  closeModeSurfacesOutside,
  displayMenuItems,
  displayModeMenuItems,
  displayModePatch,
} from "./useThreadDisplayMode";

const threadRef = {
  environmentId: EnvironmentId.make("environment-without-config"),
  threadId: ThreadId.make("thread-a"),
};

const menuState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [],
  displayModeItems: [
    {
      id: "display-mode",
      label: "Display mode",
      icon: "message-square",
      children: [
        { id: "display-mode:normal", label: "Normal mode", checked: false },
        { id: "display-mode:chat-replies", label: "Chat mode", checked: true },
      ],
    },
    { id: "dashboard:on", label: "Enable Dashboard", checked: false },
  ],
};

const display = (mode: DisplayMode, dashboard: boolean) => ({ mode, dashboard });

describe("Display mode menu", () => {
  it("is hidden when the server has not said it can store a mode", () => {
    expect(displayModeMenuItems(threadRef)).toEqual([]);
  });

  it.each([false, true])(
    "names the state a click sets on the Dashboard item, when on is %s",
    (on) => {
      const items = displayMenuItems({
        modes: true,
        dashboard: true,
        current: display(CHAT_REPLIES_DISPLAY_MODE, on),
        disabled: false,
      });
      expect(items.map((item) => [item.id, item.checked])).toEqual([
        ["display-mode", undefined],
        [on ? "dashboard:off" : "dashboard:on", on],
      ]);
      expect(items[0]?.children?.map((item) => item.checked)).toEqual([false, true]);
    },
  );

  it.each([
    ["display-mode:chat-replies", "normal", { threadDisplayModes: { "thread-a": "chat-replies" } }],
    ["display-mode:normal", "chat-replies", { threadDisplayModes: { "thread-a": null } }],
    ["display-mode:chat-replies", "chat-replies", null],
    ["display-mode:normal", undefined, null],
    ["display-mode:normal", "normal", null],
    // An older server keeps removed modes, which this client shows as Normal.
    ["display-mode:normal", "messages-only", { threadDisplayModes: { "thread-a": null } }],
    ["dashboard:on", undefined, { threadDashboards: { "thread-a": true } }],
    ["dashboard:off", "chat-replies", { threadDashboards: { "thread-a": null } }],
  ] as const)("writes only what %s sets, in a thread stored as %s", (action, stored, patch) => {
    expect(displayModePatch(threadRef, action, stored)).toEqual(patch);
  });

  it("closes the Replies and Dashboard tabs that the saved display does not have", () => {
    const openTabs = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
        .surfaces.map((surface) => surface.kind)
        .filter((kind) => kind === "replies" || kind === "dashboard");
    const openBoth = () => {
      useRightPanelStore.setState(useRightPanelStore.getInitialState());
      useRightPanelStore.getState().open(threadRef, "replies");
      useRightPanelStore.getState().open(threadRef, "dashboard");
    };
    openBoth();
    closeModeSurfacesOutside(threadRef, display(CHAT_REPLIES_DISPLAY_MODE, false));
    expect(openTabs()).toEqual(["replies"]);
    openBoth();
    closeModeSurfacesOutside(threadRef, display(NORMAL_DISPLAY_MODE, true));
    expect(openTabs()).toEqual(["dashboard"]);
  });

  it("sits after Auto-settle behavior and is disabled with the others without permission", () => {
    const ids = buildThreadActionMenuItems(menuState).map((item) => item.id);
    expect(ids.slice(ids.indexOf("auto-settle"), ids.indexOf("auto-settle") + 3)).toEqual([
      "auto-settle",
      "display-mode",
      "dashboard:on",
    ]);
    const readOnly = buildThreadActionMenuItems({ ...menuState, canOperate: false });
    expect(readOnly.find((item) => item.id === "display-mode")?.children).toMatchObject([
      { disabled: true },
      { disabled: true },
    ]);
    expect(readOnly.find((item) => item.id === "dashboard:on")).toMatchObject({ disabled: true });
  });
});
