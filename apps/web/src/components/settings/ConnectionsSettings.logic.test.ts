import {
  EnvironmentId,
  type DesktopWslState,
  type LocalServerAdvertisement,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  selectLocalServerPairingCandidates,
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

describe("selectLocalServerPairingCandidates", () => {
  const advertisement = {
    version: 1,
    instanceId: "instance-local",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    httpBaseUrl: "http://127.0.0.1:3773/",
    pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
    pairingExpiresAt: "2026-01-01T00:05:00.000Z",
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local server",
  } satisfies LocalServerAdvertisement;

  it("offers unsaved advertisements as explicit Pair actions", () => {
    expect(selectLocalServerPairingCandidates([advertisement], [])).toEqual([
      { advertisement, pairAgain: false },
    ]);
  });

  it("suppresses usable saved environments and offers Pair again for failed credentials", () => {
    expect(
      selectLocalServerPairingCandidates(
        [advertisement],
        [
          {
            environmentId: advertisement.environmentId,
            connection: { phase: "connected" },
          },
        ],
      ),
    ).toEqual([]);
    expect(
      selectLocalServerPairingCandidates(
        [advertisement],
        [
          {
            environmentId: advertisement.environmentId,
            connection: { phase: "error" },
          },
        ],
      ),
    ).toEqual([{ advertisement, pairAgain: true }]);
  });
});
