import { describe, expect, it } from "vite-plus/test";

import { resolveT3ConnectTurnOn } from "./t3ConnectState";

describe("resolveT3ConnectTurnOn", () => {
  const canLink = {
    desktopApp: true,
    linkableHere: true,
    cloudConfigured: true,
    canReadRelay: true,
    canWriteRelay: true,
    connectDenial: undefined,
  };

  it("turns on only from the desktop app, on a session the environment can link from", () => {
    expect(resolveT3ConnectTurnOn(canLink).kind).toBe("here");
    expect(resolveT3ConnectTurnOn({ ...canLink, desktopApp: false }).kind).toBe("on-host");
    expect(resolveT3ConnectTurnOn({ ...canLink, linkableHere: false }).kind).toBe("on-host");
    expect(resolveT3ConnectTurnOn({ ...canLink, canWriteRelay: false }).kind).toBe("on-host");
    expect(resolveT3ConnectTurnOn({ ...canLink, connectDenial: "Off by policy." })).toEqual({
      kind: "policy",
      reason: "Off by policy.",
    });
  });
});
