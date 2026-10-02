import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";

import { desktopLocalConnectionId } from "~/connection/desktopLocal";
import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));

vi.mock("~/connection/catalog", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map(),
      }).pipe(Atom.keepAlive),
    },
  };
});

const environmentId = EnvironmentId.make("environment-1");

/**
 * Mounts catalog entries on the environment catalog atom.
 * Host selection reads that atom when the prepared connection omits its target.
 */
function setCatalog(entries: ReadonlyArray<readonly [EnvironmentId, ConnectionCatalogEntry]>) {
  appAtomRegistry.set(
    environmentCatalog.catalogValueAtom as never,
    {
      isReady: true,
      entries: new Map(entries),
    } as never,
  );
}

describe("browser target resolver session wiring", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    setCatalog([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the mounted catalog target when the prepared connection omits it", async () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId,
      label: "WSL (Ubuntu)",
    });
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://172.24.66.27:3773" });
    setCatalog([[environmentId, { target, profile: Option.none(), enabled: true }]]);

    const { resolveDiscoveredServerUrl, resolveBrowserNavigationTarget } =
      await import("./browserTargetResolver");

    expect(resolveDiscoveredServerUrl(environmentId, "http://127.0.0.1:3001/app")).toBe(
      "http://localhost:3001/app",
    );
    expect(
      resolveBrowserNavigationTarget(environmentId, {
        kind: "environment-port",
        port: 3001,
      }).resolvedUrl,
    ).toBe("http://localhost:3001/");
  });

  it("keeps a saved remote host when that catalog target is mounted from the desktop app", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    const target = new BearerConnectionTarget({
      connectionId: "saved-lan",
      environmentId,
      label: "LAN",
    });
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    setCatalog([[environmentId, { target, profile: Option.none(), enabled: true }]]);

    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");

    expect(resolveDiscoveredServerUrl(environmentId, "localhost:3000/app")).toBe(
      "http://192.168.1.25:3000/app",
    );
  });

  it("keeps a desktop primary on localhost and a browser primary on the advertised host", async () => {
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: "WSL",
      httpBaseUrl: "http://172.24.66.27:3773",
      wsBaseUrl: "ws://172.24.66.27:3773",
    });
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://172.24.66.27:3773" });
    setCatalog([[environmentId, { target, profile: Option.none(), enabled: true }]]);

    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");

    expect(resolveDiscoveredServerUrl(environmentId, "localhost:3001")).toBe(
      "http://172.24.66.27:3001/",
    );

    vi.stubGlobal("window", { desktopBridge: {} });
    expect(resolveDiscoveredServerUrl(environmentId, "localhost:3001")).toBe(
      "http://localhost:3001/",
    );
  });

  it("falls back to the prepared connection target when the catalog has no entry", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://172.24.66.27:3773",
      target: new BearerConnectionTarget({
        connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
        environmentId,
        label: "WSL (Ubuntu)",
      }),
    });

    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");

    expect(resolveDiscoveredServerUrl(environmentId, "localhost:3001")).toBe(
      "http://localhost:3001/",
    );
  });
});
