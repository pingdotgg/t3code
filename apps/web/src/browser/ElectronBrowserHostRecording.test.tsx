import { createElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ElectronBrowserHost } from "./ElectronBrowserHost";

const fixture = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  tabIds: new Set<string>(),
  stops: [] as string[],
  saved: [] as unknown[],
  errors: [] as unknown[],
}));

function publish(tabIds: readonly string[]) {
  fixture.tabIds = new Set(tabIds);
  for (const listener of fixture.listeners) listener();
}

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/previewStateStore", () => ({ useActivePreviewSessions: () => ({}) }));
vi.mock("./BrowserEngineHostConnection", () => ({ BrowserEngineHostConnection: () => null }));
vi.mock("./browserPointerStore", () => ({ useBrowserPointerStore: {} }));
vi.mock("./HostedBrowserWebview", () => ({ HostedBrowserWebview: () => null }));
vi.mock("~/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      createElement("button", props),
  };
});
vi.mock("~/components/ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipPopup: () => null,
    TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children),
  };
});
vi.mock("./browserRecording", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBridgeBrowserRecordingTabIds: () =>
      useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
        () => fixture.tabIds,
      ),
    stopBrowserRecording: async (tabId: string) => {
      fixture.stops.push(tabId);
      publish([...fixture.tabIds].filter((current) => current !== tabId));
      return { id: tabId, path: "/private/recording.webm" };
    },
  };
});
vi.mock("./browserRecordingToast", () => ({
  showBrowserRecordingSavedToast: (artifact: unknown) => fixture.saved.push(artifact),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (value: unknown) => fixture.errors.push(value) },
}));

afterEach(() => vi.unstubAllGlobals());

it("the host shows bridge-owned stop controls even with no rendered pack or session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(ElectronBrowserHost));
  });
  try {
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await act(async () => publish(["pack-tab-1", "pack-tab-2"]));
    const stopControls = () =>
      renderer.root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Stop recording",
      );
    const controls = stopControls();
    expect(controls).toHaveLength(2);
    expect(
      renderer.root.findAll(
        (node) => node.type === "span" && node.props.className?.includes("animate-status-pulse"),
      ),
    ).toHaveLength(2);
    await act(async () => controls[0]!.props.onClick({ shiftKey: false }));
    expect(fixture.stops).toEqual(["pack-tab-1"]);
    expect(fixture.saved).toHaveLength(1);
    expect(fixture.errors).toHaveLength(0);
    expect(stopControls()).toHaveLength(1);
  } finally {
    await act(async () => renderer.unmount());
  }
  expect(fixture.listeners.size).toBe(0);
});
