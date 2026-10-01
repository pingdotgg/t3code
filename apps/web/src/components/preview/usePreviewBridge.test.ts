import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { isHostedEngineClaimPending, useBrowserEngineHostStore } from "~/browser/browserEngineHost";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { projectDesktopState, usePreviewBridge } from "./usePreviewBridge";

const fixture = vi.hoisted(() => ({
  claim: vi.fn<() => Promise<AsyncResult.AsyncResult<void, string>>>(),
  command: vi.fn<() => Promise<AsyncResult.AsyncResult<void, string>>>(),
  subscribe: vi.fn((_listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => {}),
}));

vi.mock("./previewBridge", () => ({ previewBridge: { onStateChange: fixture.subscribe } }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    engineHostClaim: "claim",
    engineHostRelease: "release",
    engineHostReport: "report",
    reportStatus: "status",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "claim" ? fixture.claim : fixture.command),
}));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => Option.none() }));
vi.mock("~/previewStateStore", () => ({ applyPreviewDesktopState: vi.fn() }));
vi.mock("~/browserFaviconStore", () => ({
  useFaviconProjectRefForThread: () => null,
  flushPendingFaviconsForThread: vi.fn(),
  recordFaviconForThread: vi.fn(),
}));

const favicon = {
  dataUrl: "data:image/png;base64,AAAA",
  pageUrl: "http://localhost:3000/app",
  capturedAt: 1,
};

function state(navStatus: DesktopPreviewTabState["navStatus"]): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    remoteLive: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    devToolsOpen: false,
    controller: "none",
    favicon,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("usePreviewBridge engine claim", () => {
  it("settles a rejected owner claim without waiting for another guest state event", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const threadRef = {
      environmentId: EnvironmentId.make("env-claim"),
      threadId: ThreadId.make("thread-claim"),
    };
    const serverEpoch = "epoch-claim";
    const tabId = "tab-claim";
    const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
    const store = useBrowserEngineHostStore.getState();
    store.setHostConnectionId(threadRef.environmentId, "host-claim");
    fixture.command.mockResolvedValue(AsyncResult.success(undefined));
    let resolveClaim: (result: AsyncResult.AsyncResult<void, string>) => void = () => {};
    fixture.claim.mockReturnValue(
      new Promise((resolve) => {
        resolveClaim = resolve;
      }),
    );
    fixture.subscribe.mockClear();
    const Probe = () => {
      usePreviewBridge({ threadRef, tabId, runtimeTabId, serverEpoch });
      return null;
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      const listener = fixture.subscribe.mock.calls.at(-1)?.[0];
      if (!listener) throw new Error("expected native state subscription");
      await act(async () => {
        listener(runtimeTabId, state({ kind: "Success", url: "https://a.test/", title: "A" }));
      });
      expect(fixture.claim).toHaveBeenCalledTimes(1);
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        true,
      );
      await act(async () => {
        resolveClaim(AsyncResult.failure(Cause.fail("claim refused")));
      });
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        false,
      );
      expect(fixture.claim).toHaveBeenCalledTimes(1);
      fixture.claim.mockReturnValue(
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
      );
      await act(async () => {
        listener(runtimeTabId, state({ kind: "Loading", url: "https://a.test/", title: "A" }));
      });
      expect(fixture.claim).toHaveBeenCalledTimes(2);
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        false,
      );
      await act(async () => {
        resolveClaim(AsyncResult.failure(Cause.fail("claim still refused")));
      });
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        false,
      );
      fixture.claim.mockReturnValue(
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
      );
      await act(async () => {
        listener(runtimeTabId, state({ kind: "Success", url: "https://a.test/", title: "A" }));
      });
      expect(fixture.claim).toHaveBeenCalledTimes(3);
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        false,
      );
      await act(async () => {
        resolveClaim(AsyncResult.success(undefined));
      });
      expect(useBrowserEngineHostStore.getState().failedClaimByTabId[runtimeTabId]).toBeUndefined();
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, "epoch-next")).toBe(
        true,
      );
      store.setHostConnectionId(threadRef.environmentId, "host-replacement");
      expect(isHostedEngineClaimPending(threadRef.environmentId, runtimeTabId, serverEpoch)).toBe(
        true,
      );
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      store.setHostConnectionId(threadRef.environmentId, null);
      vi.unstubAllGlobals();
    }
  });
});

describe("projectDesktopState", () => {
  it("shows a retained icon only while the current document has the captured origin", () => {
    expect(
      projectDesktopState(
        state({ kind: "Loading", url: "http://localhost:3000/reload", title: "" }),
      ).favicon,
    ).toEqual(favicon);
    expect(
      projectDesktopState(
        state({
          kind: "LoadFailed",
          url: "https://example.com/",
          title: "",
          code: -105,
          description: "failed",
        }),
      ).favicon,
    ).toBeNull();
    expect(projectDesktopState(state({ kind: "Idle" })).favicon).toBeNull();
  });
});
