import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: false,
  primary: null as string | null,
  serverBrowser: new Set<string>(),
}));

vi.mock("~/env", () => ({
  get isElectron() {
    return state.desktop;
  },
}));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.primary } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => false,
}));

import {
  alternatePreviewRuntime,
  previewRuntimeFor,
  rendersServerTabNatively,
} from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("previewRuntimeFor", () => {
  it("opens a remote environment's tabs on this computer in the desktop app", () => {
    state.desktop = true;
    state.primary = local;
    state.serverBrowser = new Set([local, remote]);

    expect(previewRuntimeFor(remote)).toBeUndefined();
    expect(previewRuntimeFor(local)).toBe("server");
  });

  it("uses the environment's browser where the client has none of its own", () => {
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote)).toBe("server");
  });
});

describe("alternatePreviewRuntime", () => {
  it("moves a remote environment's tab between this computer and the environment", () => {
    state.desktop = true;

    expect(alternatePreviewRuntime(remote, local, true, {})).toBe("server");
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
    expect(alternatePreviewRuntime(local, local, true, {})).toBeNull();
    expect(alternatePreviewRuntime(remote, local, false, {})).toBeNull();
  });

  it("offers no move outside the desktop app", () => {
    expect(alternatePreviewRuntime(remote, null, true, { runtime: "server" })).toBeNull();
  });
});

describe("rendersServerTabNatively", () => {
  it("streams a local tab after headless fallback while retaining native and legacy tabs", () => {
    state.desktop = true;
    expect(rendersServerTabNatively(local, local, { runtime: "server" })).toBe(true);
    expect(
      rendersServerTabNatively(local, local, {
        runtime: "server",
        serverPageMode: "native",
      }),
    ).toBe(true);
    expect(
      rendersServerTabNatively(local, local, {
        runtime: "server",
        serverPageMode: "headless",
      }),
    ).toBe(false);
  });

  it("never hosts remote or non-server tabs as local server webviews", () => {
    state.desktop = true;
    expect(
      rendersServerTabNatively(remote, local, {
        runtime: "server",
        serverPageMode: "native",
      }),
    ).toBe(false);
    expect(rendersServerTabNatively(local, null, { runtime: "server" })).toBe(false);
    expect(rendersServerTabNatively(local, local, { runtime: "desktop" })).toBe(false);
    expect(rendersServerTabNatively(local, local, null)).toBe(false);
  });

  it("streams native server pages in a web client", () => {
    expect(
      rendersServerTabNatively(local, local, {
        runtime: "server",
        serverPageMode: "native",
      }),
    ).toBe(false);
  });
});
