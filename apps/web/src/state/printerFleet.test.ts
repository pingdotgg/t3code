import {
  EnvironmentId,
  PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectFleetPrinters, selectFleetPrinter } from "./printerFleet";

function makeSnapshot(id: string, label: string, online = true): PrinterSnapshot {
  return {
    id: PrinterId.make(id),
    label,
    kind: "home-assistant-bambu",
    connectionState: online ? "connected" : "offline",
    online,
    lastSyncedAt: "2026-11-21T07:00:00.000Z",
    lastUpdatedAt: "2026-11-21T07:00:00.000Z",
    stale: !online,
    hardware: {
      model: "Bambu Lab P1S",
      name: label,
      serial: null,
      firmware: null,
      ipAddress: null,
      nozzleSizeMm: 0.4,
      nozzleType: null,
      bedType: null,
      totalUsageHours: null,
      wifiSignalDbm: null,
      sdCardStatus: null,
      connectionMode: null,
      controlBlocked: false,
    },
    job: {
      status: online ? "idle" : "offline",
      stage: null,
      stageLabel: online ? "Idle" : "Offline",
      fileName: null,
      displayName: null,
      progressPercent: null,
      currentLayer: null,
      totalLayers: null,
      remainingSeconds: null,
      elapsedSeconds: null,
      startedAt: null,
      estimatedFinishAt: null,
      weightGrams: null,
      lengthMeters: null,
      timelapse: null,
      printableObjects: [],
    },
    thermals: {
      nozzle: { actualC: 25, targetC: 0 },
      bed: { actualC: 24, targetC: 0 },
      history: [],
    },
    fans: {
      coolingPercent: 0,
      auxPercent: 0,
      chamberPercent: 0,
      heatbreakPercent: 0,
    },
    lighting: { chamberLight: false },
    speed: { profile: "standard", modifierPercent: 100 },
    filament: { extruderLoaded: false, externalSpool: null, amsUnits: [] },
    alerts: [],
    media: {
      hasCamera: true,
      hasCoverImage: false,
      hasPickImage: false,
      cameraUpdatedAt: null,
      cameraStale: false,
      cameraRevision: 1,
      coverUpdatedAt: null,
    },
    capabilities: {
      canPause: false,
      canResume: false,
      canStop: false,
      canSetTemps: true,
      canSetFans: true,
      canSetLight: true,
      canSetSpeed: true,
      canJog: true,
      canSkipObjects: false,
    },
  };
}

function makeState(printers: ReadonlyArray<PrinterSnapshot>, enabled = true): PrinterServiceState {
  return {
    enabled,
    agentAccessEnabled: true,
    mediaBasePath: "/api/printer-media",
    printers,
    sessions: [],
    revision: 1,
  };
}

describe("printerFleet T3 Connect proxy routing", () => {
  const remoteVps = EnvironmentId.make("env-vps");
  const homeProxy = EnvironmentId.make("env-home");
  const labProxy = EnvironmentId.make("env-lab");

  it("discovers printers hosted on a connected T3 Connect proxy when the thread environment has none", () => {
    const entries = collectFleetPrinters(
      [
        {
          environmentId: remoteVps,
          label: "Cloud VPS",
          relayManaged: true,
          state: makeState([], false),
        },
        {
          environmentId: homeProxy,
          label: "Home LAN",
          relayManaged: true,
          state: makeState([makeSnapshot("p1s", "Studio P1S", true)]),
        },
      ],
      remoteVps,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.proxyEnvironmentId).toBe(homeProxy);
    expect(entries[0]?.proxyEnvironmentLabel).toBe("Home LAN");
    expect(entries[0]?.isLocalToThread).toBe(false);
    expect(entries[0]?.isProxied).toBe(true);

    const active = selectFleetPrinter(entries);
    expect(active?.printer.id).toBe("p1s");
    expect(active?.proxyEnvironmentId).toBe(homeProxy);
  });

  it("prefers local printers first, then online proxy printers, and respects pinned proxyEnvironmentId", () => {
    const entries = collectFleetPrinters(
      [
        {
          environmentId: labProxy,
          label: "Lab Box",
          relayManaged: true,
          state: makeState([makeSnapshot("shared-id", "Lab P1S", false)]),
        },
        {
          environmentId: homeProxy,
          label: "Home LAN",
          relayManaged: true,
          state: makeState([makeSnapshot("shared-id", "Home P1S", true)]),
        },
      ],
      remoteVps,
    );

    expect(entries.map((entry) => entry.printer.label)).toEqual(["Home P1S", "Lab P1S"]);

    const pinnedLab = selectFleetPrinter(entries, "shared-id", labProxy);
    expect(pinnedLab?.proxyEnvironmentId).toBe(labProxy);
    expect(pinnedLab?.printer.label).toBe("Lab P1S");

    // Legacy pin without proxyEnvironmentId must fail closed when multiple environments share the same printerId.
    expect(selectFleetPrinter(entries, "shared-id")).toBeUndefined();

    // Unique legacy printerId without proxyEnvironmentId still resolves cleanly.
    const uniqueEntries = collectFleetPrinters(
      [
        {
          environmentId: homeProxy,
          label: "Home LAN",
          relayManaged: true,
          state: makeState([makeSnapshot("unique-p1s", "Home P1S", true)]),
        },
        {
          environmentId: labProxy,
          label: "Lab Box",
          relayManaged: true,
          state: makeState([makeSnapshot("other-id", "Lab Voron", true)]),
        },
      ],
      remoteVps,
    );
    expect(selectFleetPrinter(uniqueEntries, "unique-p1s")?.proxyEnvironmentId).toBe(homeProxy);

    // Pinned surfaces must never silently fall back to another printer or environment when their target disappears.
    expect(selectFleetPrinter(entries, "shared-id", remoteVps)).toBeUndefined();
    expect(selectFleetPrinter(entries, "missing-id", homeProxy)).toBeUndefined();
    expect(selectFleetPrinter(entries, "missing-id")).toBeUndefined();
    expect(selectFleetPrinter(entries, undefined, remoteVps)).toBeUndefined();
    // Unpinned surface still auto-selects the best available fleet printer.
    expect(selectFleetPrinter(entries)?.proxyEnvironmentId).toBe(homeProxy);
  });
});
