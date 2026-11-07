import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
  type DesktopPreviewTabState,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  listeners: new Set<Parameters<DesktopPreviewBridge["onStateChange"]>[0]>(),
}));

// The desktop bridge only exists inside Electron; the hook reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    onStateChange: (listener: Parameters<DesktopPreviewBridge["onStateChange"]>[0]) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  } as never,
}));

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { usePreviewBridge } from "./usePreviewBridge";

const threadRef = scopeThreadRef(EnvironmentId.make("env-bridge"), ThreadId.make("thread-bridge"));

function Bridge() {
  usePreviewBridge({ threadRef, tabId: "tab_a", runtimeTabId: "runtime_a", serverDriven: true });
  return null;
}

const audible: DesktopPreviewTabState = {
  tabId: "runtime_a",
  webContentsId: 1,
  navStatus: { kind: "Success", url: "https://example.com/", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  pictureInPicture: false,
  colorScheme: "system",
  audioMuted: false,
  audible: true,
  controller: "none",
  capturing: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("usePreviewBridge", () => {
  it("drops a tab's desktop state when its guest is torn down", async () => {
    mocks.listeners.clear();
    resetPreviewStateForTests();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <Bridge />
      </AppAtomRegistryProvider>,
    );
    await act(() => mocks.listeners.forEach((listener) => listener("runtime_a", audible)));
    expect(readThreadPreviewState(threadRef).desktopByTabId.tab_a?.audible).toBe(true);

    await screen.unmount();
    expect(readThreadPreviewState(threadRef).desktopByTabId.tab_a).toBeUndefined();
  });
});
