import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { ElectronBrowserHost } from "./ElectronBrowserHost";

const connection = Atom.make(Option.some({ httpBaseUrl: "http://old-host" }));
const sessions = {
  [scopedThreadKey({ environmentId: "local", threadId: "design" } as ScopedThreadRef)]: {
    serverEpoch: "server",
    desktopByTabId: {},
    sessions: {
      browser: {
        tabId: "browser",
        navStatus: { _tag: "Loading", url: "https://example.com" },
      },
      design: {
        tabId: "design",
        navStatus: {
          _tag: "Loading",
          url: "http://new-host/api/assets/file?t3-design=1&t3-design-path=.t3/designs/test.html",
        },
      },
    },
  },
};
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/previewStateStore", () => ({ useActivePreviewSessions: () => sessions }));
vi.mock("~/state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => connection },
}));
vi.mock("./HostedBrowserWebview", () => ({
  HostedBrowserWebview: () => <div>Native browser</div>,
}));

it("updates design filtering without unmounting browser guests during reconnect", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(() => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <ElectronBrowserHost />
        </RegistryContext.Provider>,
      );
    });
    expect(renderer!.root.findAllByType("div")).toHaveLength(3);
    const browser = renderer!.root.findAllByType("div")[1];
    await act(() => registry.set(connection, Option.some({ httpBaseUrl: "http://new-host" })));
    expect(renderer!.root.findAllByType("div")).toHaveLength(2);
    await act(() => registry.set(connection, Option.none()));
    expect(renderer!.root.findAllByType("div")).toHaveLength(2);
    expect(renderer!.root.findAllByType("div")[1]).toBe(browser);
    await act(() => registry.set(connection, Option.some({ httpBaseUrl: "http://new-host" })));
    expect(renderer!.root.findAllByType("div")).toHaveLength(2);
    expect(renderer!.root.findAllByType("div")[1]).toBe(browser);
  } finally {
    await act(() => renderer?.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
