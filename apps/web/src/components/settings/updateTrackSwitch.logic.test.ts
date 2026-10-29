import type { DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prepareLocalTrackSwitch } from "./updateTrackSwitch.logic";

const STABLE = "0.1.3";

/** Like the desktop app, saving a track re-checks the feed and reports what it offers. */
function fakeBridge(offer: string | null | Error) {
  const saved: DesktopUpdateChannel[] = [];
  const base: DesktopUpdateState = {
    enabled: true,
    status: "up-to-date",
    channel: "nightly",
    currentVersion: "0.1.4-nightly.20261027.3796",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  return {
    saved,
    bridge: {
      setUpdateChannel: async (channel: DesktopUpdateChannel) => {
        saved.push(channel);
        if (offer instanceof Error) throw offer;
        return {
          ...base,
          channel,
          status: offer === null ? ("up-to-date" as const) : ("available" as const),
          availableVersion: offer,
        };
      },
    },
  };
}

const prepare = (bridge: ReturnType<typeof fakeBridge>["bridge"], reinstall = true) =>
  prepareLocalTrackSwitch(bridge, { channel: "latest", version: STABLE, reinstall });

describe("prepareLocalTrackSwitch", () => {
  it("installs the checked release or a newer one on the track, never an older one", async () => {
    expect(await prepare(fakeBridge(STABLE).bridge)).toMatchObject({ ok: true });
    // A newer Stable knows every migration the checked one does.
    expect(await prepare(fakeBridge("0.1.4").bridge)).toMatchObject({ ok: true });

    const stale = fakeBridge("0.1.2");
    expect(await prepare(stale.bridge)).toEqual({
      ok: false,
      message: "This app found 0.1.2, which is older than 0.1.3. Try again in a few minutes.",
    });
    // The saved track is intent; "Switch them" retries without re-picking it.
    expect(stale.saved).toEqual(["latest"]);
  });

  it("reports a track that could not be saved", async () => {
    expect(await prepare(fakeBridge(new Error("feed check failed")).bridge)).toEqual({
      ok: false,
      message: "feed check failed",
    });
  });

  it("only saves the track when this app is already on it", async () => {
    const undo = fakeBridge(null);
    expect(await prepare(undo.bridge, false)).toEqual({ ok: true, local: null });
    expect(undo.saved).toEqual(["latest"]);
  });
});
