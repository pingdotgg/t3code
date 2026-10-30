import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const tabA = browserMiniPlayerSource("tab-a");
const tabB = browserMiniPlayerSource("tab-b");

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
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
