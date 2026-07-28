import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DesktopWslState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  environmentPairingBaseUrl,
  resolveAccessEnvironment,
  resolveShareablePairingUrl,
} from "./ConnectionsSettings.logic";

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

const primaryId = EnvironmentId.make("primary-env");
const savedId = EnvironmentId.make("saved-env");

describe("resolveAccessEnvironment", () => {
  it("administers the managed backend when one exists, even while viewing a saved environment", () => {
    expect(
      resolveAccessEnvironment({
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: savedId,
      }),
    ).toEqual({ environmentId: primaryId, isPrimary: true });
  });

  it("administers the selected environment when there is no managed backend", () => {
    expect(
      resolveAccessEnvironment({
        primaryEnvironmentId: null,
        activeEnvironmentId: savedId,
      }),
    ).toEqual({ environmentId: savedId, isPrimary: false });
  });

  it("has nothing to administer when no environment is selected either", () => {
    expect(
      resolveAccessEnvironment({ primaryEnvironmentId: null, activeEnvironmentId: null }),
    ).toEqual({ environmentId: null, isPrimary: false });
  });
});

describe("environmentPairingBaseUrl", () => {
  const entry = (
    target: ConnectionCatalogEntry["target"],
    profile?: unknown,
  ): ConnectionCatalogEntry => ({
    target,
    profile: (profile === undefined
      ? Option.none()
      : Option.some(profile)) as ConnectionCatalogEntry["profile"],
  });

  it("uses a bearer environment's own base URL", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new BearerConnectionTarget({
            environmentId: savedId,
            label: "headless",
            connectionId: "bearer:saved-env",
          }),
          new BearerConnectionProfile({
            connectionId: "bearer:saved-env",
            environmentId: savedId,
            label: "headless",
            httpBaseUrl: "https://box.tail.ts.net/",
            wsBaseUrl: "wss://box.tail.ts.net/",
          }),
        ),
      ),
    ).toBe("https://box.tail.ts.net/");
  });

  it("uses the primary's base URL", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new PrimaryConnectionTarget({
            environmentId: primaryId,
            label: "local",
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
          }),
        ),
      ),
    ).toBe("http://127.0.0.1:3773/");
  });

  it("has no shareable URL for a bearer environment whose profile is missing", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new BearerConnectionTarget({
            environmentId: savedId,
            label: "headless",
            connectionId: "bearer:saved-env",
          }),
        ),
      ),
    ).toBeNull();
  });

  it("has no shareable URL for an SSH tunnel, whose local address is meaningless elsewhere", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new SshConnectionTarget({
            environmentId: savedId,
            label: "box",
            connectionId: "ssh:box",
          }),
          new SshConnectionProfile({
            connectionId: "ssh:box",
            environmentId: savedId,
            label: "box",
            target: { alias: "box", hostname: "box", username: "ivan", port: 22 },
          }),
        ),
      ),
    ).toBeNull();
  });

  it("has no shareable URL for a relay environment", () => {
    expect(
      environmentPairingBaseUrl(
        entry(new RelayConnectionTarget({ environmentId: savedId, label: "cloud" })),
      ),
    ).toBeNull();
  });
});

describe("resolveShareablePairingUrl", () => {
  const currentOriginPairingUrl = "https://client.example/pair?token=secret";

  it("prefers the selected advertised endpoint", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: "https://box.tail.ts.net/pair?token=secret",
        basePairingUrl: "http://192.168.1.5:3773/pair?token=secret",
        currentOriginPairingUrl,
        servesCurrentOrigin: true,
      }),
    ).toBe("https://box.tail.ts.net/pair?token=secret");
  });

  it("falls back to the administered server's own base URL", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: "http://192.168.1.5:3773/pair?token=secret",
        currentOriginPairingUrl,
        servesCurrentOrigin: false,
      }),
    ).toBe("http://192.168.1.5:3773/pair?token=secret");
  });

  it("uses this page's origin only for the server that serves this page", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: null,
        currentOriginPairingUrl,
        servesCurrentOrigin: true,
      }),
    ).toBe(currentOriginPairingUrl);
  });

  it("shows the bare code for another server with no address, not a link to this client", () => {
    // A relay or SSH environment, or a bearer environment whose profile is
    // missing: an origin-relative link would pair the scanning device to this
    // client app instead of the server the link belongs to.
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: null,
        currentOriginPairingUrl,
        servesCurrentOrigin: false,
      }),
    ).toBeNull();
  });

  it("shows the bare code when this page's origin is loopback", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: null,
        currentOriginPairingUrl: "http://localhost:3773/pair?token=secret",
        servesCurrentOrigin: true,
      }),
    ).toBeNull();
  });

  it.each([
    "http://localhost:3773/pair?token=secret",
    "http://127.0.0.1:3773/pair?token=secret",
    "http://[::1]:3773/pair?token=secret",
  ])("skips the loopback advertised endpoint %s", (endpointPairingUrl) => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl,
        basePairingUrl: "http://192.168.1.5:3773/pair?token=secret",
        currentOriginPairingUrl,
        servesCurrentOrigin: true,
      }),
    ).toBe("http://192.168.1.5:3773/pair?token=secret");
  });

  it("skips a loopback base URL and falls back to a shareable current origin", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: "http://127.0.0.1:3773/pair?token=secret",
        currentOriginPairingUrl,
        servesCurrentOrigin: true,
      }),
    ).toBe(currentOriginPairingUrl);
  });

  it("shows the bare code when another server only has a loopback base URL", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: null,
        basePairingUrl: "http://127.0.0.1:3773/pair?token=secret",
        currentOriginPairingUrl,
        servesCurrentOrigin: false,
      }),
    ).toBeNull();
  });

  it("skips a hosted app link whose wrapped backend URL is loopback", () => {
    expect(
      resolveShareablePairingUrl({
        endpointPairingUrl: "https://t3.chat/pair?host=https%3A%2F%2Flocalhost%3A3773&token=secret",
        basePairingUrl: null,
        currentOriginPairingUrl,
        servesCurrentOrigin: false,
      }),
    ).toBeNull();
  });

  it.each(["", "not-a-url", "/relative"])(
    "skips a hosted app link whose wrapped backend URL is malformed: %s",
    (host) => {
      expect(
        resolveShareablePairingUrl({
          endpointPairingUrl: `https://t3.chat/pair?host=${encodeURIComponent(host)}&token=secret`,
          basePairingUrl: null,
          currentOriginPairingUrl,
          servesCurrentOrigin: false,
        }),
      ).toBeNull();
    },
  );
});
