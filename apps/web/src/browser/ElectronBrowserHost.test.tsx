import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("./HostedBrowserWebview", () => ({
  HostedBrowserWebview: (props: { readonly tabId: string }) => (
    <div data-preview-server-tab={props.tabId} />
  ),
}));

import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

const renderedTabIds = () =>
  renderer!.root
    .findAll((node) => node.type === "div" && node.props["data-preview-server-tab"] !== undefined)
    .map((node) => node.props["data-preview-server-tab"] as string);

describe("ElectronBrowserHost", () => {
  it("keeps webview order when the server reorders tabs by last update", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    reconcilePreviewServerSessions(ref, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
      );
    });
    const initialOrder = renderedTabIds();

    await act(() => {
      reconcilePreviewServerSessions(ref, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });

    expect(initialOrder).toHaveLength(2);
    expect(renderedTabIds()).toEqual(initialOrder);
  });
});
