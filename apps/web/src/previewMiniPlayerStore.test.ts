import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";
import { resolveChatCanvasLayout } from "./components/chat/chatCanvasLayout";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./components/chat/threadDetailsCardLayout";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const tabA = browserMiniPlayerSource("tab-a");
const tabB = browserMiniPlayerSource("tab-b");

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("keeps a resized preview and folded details card in place when dragging starts", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, tabA);
    store.resize(refA, "browser:tab-a", 460, { x: 1112, y: 275 });
    const container = { width: 1584, height: 988 };
    const layout = () => {
      const player = selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        refA,
      )!;
      return resolveChatCanvasLayout({
        container,
        maxChatWidth: 736,
        composerHeight: 206,
        detailsCard: { left: 1260, right: 1572, bottom: 339 },
        preview: { ...player, key: "browser:tab-a", source: { width: 1000, height: 1523 } },
      });
    };
    const resized = layout();
    expect(resized.frame).toEqual({ x: 1112, y: 275, width: 460, height: 701 });
    store.move(refA, "browser:tab-a", { x: 1106, y: 275 });
    const dragged = layout();
    expect(dragged.frame).toEqual({ ...resized.frame, x: 1106 });
    const card = resolveThreadDetailsCardLayout({
      container,
      lane: { padding: 48, minChatWidth: 640 },
      frame: dragged.frame,
      overlapsDetailsCard: dragged.overlapsDetailsCard,
    })!;
    expect(resolveThreadDetailsCardDensity(card.height, { full: 327, compact: 182 })).toBe(
      "compact",
    );
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: null,
      width: null,
      lastInteraction: "drag",
    });
  });
});
