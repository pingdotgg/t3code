import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DraftId } from "../composerDraftStore";
import {
  resolveChatPaneRenderMode,
  resolveChatSplitDropPlacement,
  shouldSyncFocusedLeafToRoute,
} from "./ChatSplitArea";

describe("resolveChatSplitDropPlacement", () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };

  it.each([
    ["left", 15, 70],
    ["right", 205, 70],
    ["top", 110, 25],
    ["bottom", 110, 115],
  ] as const)("resolves the nearest %s edge", (placement, clientX, clientY) => {
    expect(resolveChatSplitDropPlacement({ rect, clientX, clientY })).toBe(placement);
  });
});

describe("resolveChatPaneRenderMode", () => {
  it("keeps the focused server pane live", () => {
    expect(
      resolveChatPaneRenderMode({
        isFocused: true,
        target: {
          kind: "server",
          threadRef: {
            environmentId: EnvironmentId.make("env-local"),
            threadId: ThreadId.make("thread-a"),
          },
        },
      }),
    ).toBe("live");
  });

  it("keeps unfocused server panes live", () => {
    expect(
      resolveChatPaneRenderMode({
        isFocused: false,
        target: {
          kind: "server",
          threadRef: {
            environmentId: EnvironmentId.make("env-local"),
            threadId: ThreadId.make("thread-a"),
          },
        },
      }),
    ).toBe("live");
  });

  it("renders draft targets live so they can be composed in place", () => {
    expect(
      resolveChatPaneRenderMode({
        isFocused: true,
        target: {
          kind: "draft",
          draftId: DraftId.make("draft-a"),
        },
      }),
    ).toBe("live");
  });
});

describe("shouldSyncFocusedLeafToRoute", () => {
  const environmentId = EnvironmentId.make("env-local");
  const serverTarget = {
    kind: "server" as const,
    threadRef: {
      environmentId,
      threadId: ThreadId.make("thread-a"),
    },
  };

  it("does not navigate when target and diff state already match", () => {
    expect(
      shouldSyncFocusedLeafToRoute({
        focusedLeafTarget: serverTarget,
        focusedLeafDiff: { diff: "1" },
        routeTarget: serverTarget,
        routeDiffSearch: { diff: "1" },
      }),
    ).toBe(false);
  });

  it("navigates when only diff state diverges", () => {
    expect(
      shouldSyncFocusedLeafToRoute({
        focusedLeafTarget: serverTarget,
        focusedLeafDiff: { diff: "1" },
        routeTarget: serverTarget,
        routeDiffSearch: {},
      }),
    ).toBe(true);
  });

  it("navigates when the focused target changes", () => {
    expect(
      shouldSyncFocusedLeafToRoute({
        focusedLeafTarget: {
          kind: "server",
          threadRef: {
            environmentId,
            threadId: ThreadId.make("thread-b"),
          },
        },
        focusedLeafDiff: {},
        routeTarget: serverTarget,
        routeDiffSearch: {},
      }),
    ).toBe(true);
  });
});
