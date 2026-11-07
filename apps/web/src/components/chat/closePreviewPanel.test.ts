import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";

import { closePreviewPanel } from "./closePreviewPanel";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("closePreviewPanel", () => {
  it("does not resurrect a floating preview the user already turned off", () => {
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource("tab-1"));
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");
    usePreviewMiniPlayerStore.getState().close(threadRef);

    closePreviewPanel(threadRef);

    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBeNull();
  });

  it("keeps an existing floating preview across a temporary dock into the panel", () => {
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource("tab-1"));
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");

    closePreviewPanel(threadRef);

    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBe("tab-1");
  });
});
