import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { collectFleetPrinters } from "~/state/printerFleet";
import { render } from "../../../test/render";
import { PrinterPanel } from "./PrinterPanel";

const mockStateRef = vi.hoisted(() => ({
  current: null as PrinterServiceState | null,
  proxyEnv: null as { readonly id: EnvironmentId; readonly label: string } | null,
}));

const mockRunCommand = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("~/state/printer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/printer")>();
  return {
    ...actual,
    printerEnvironment: {
      action: {
        permissionAtom: () => "printer.action.permission",
      },
      list: {
        permissionAtom: () => "printer.list.permission",
      },
    },
    useFleetPrinters: (threadEnvironmentId: EnvironmentId | null) => {
      const state = mockStateRef.current ?? {
        enabled: false,
        agentAccessEnabled: false,
        mediaBasePath: "/api/printer-media",
        printers: [],
        sessions: [],
        revision: 0,
      };
      const sourceEnvId =
        mockStateRef.proxyEnv?.id ?? threadEnvironmentId ?? EnvironmentId.make("env-1");
      const sourceLabel = mockStateRef.proxyEnv?.label ?? "Local";
      const entries = collectFleetPrinters(
        [
          {
            environmentId: sourceEnvId,
            label: sourceLabel,
            relayManaged: mockStateRef.proxyEnv !== null,
            state,
          },
        ],
        threadEnvironmentId,
      );
      return {
        entries,
        localState: mockStateRef.proxyEnv ? { ...state, printers: [] } : state,
        loaded: true,
        error: null,
      };
    },
    usePrinterMediaAccess: () => ({
      httpBase: "/api/printer-media",
      query: {},
    }),
    refreshPrinterMediaAccess: vi.fn(),
    buildPrinterMediaUrl: (
      _access: unknown,
      printerId: string,
      asset: string,
      cacheKey: string | number,
    ) =>
      `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="%23222"/><text x="10" y="50" fill="%23fff">${printerId}:${asset}:${cacheKey}</text></svg>`,
  };
});

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mockRunCommand,
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: () => true,
  };
});

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

function makePrinter(overrides?: Partial<PrinterSnapshot>): PrinterSnapshot {
  return {
    id: PrinterId.make("p1s-studio"),
    label: "Studio P1S",
    kind: "home-assistant-bambu",
    connectionState: "connected",
    online: true,
    lastSyncedAt: "2026-11-21T01:00:00.000Z",
    lastUpdatedAt: "2026-11-21T00:59:58.000Z",
    stale: false,
    hardware: {
      model: "Bambu Lab P1S",
      name: "Studio P1S",
      serial: "01P00TEST0001",
      firmware: "01.08.02.00",
      ipAddress: null,
      nozzleSizeMm: 0.4,
      nozzleType: "Hardened Steel",
      bedType: "Textured PEI Plate",
      totalUsageHours: 420,
      wifiSignalDbm: -54,
      sdCardStatus: "present",
      connectionMode: "LAN",
      controlBlocked: false,
    },
    job: {
      status: "running",
      stage: "printing",
      stageLabel: "Printing",
      fileName: "desk-rear-edge-jig.gcode.3mf",
      displayName: "desk-rear-edge-jig",
      progressPercent: 42,
      currentLayer: 50,
      totalLayers: 120,
      remainingSeconds: 2700,
      elapsedSeconds: 1800,
      startedAt: "2026-11-21T00:30:00.000Z",
      estimatedFinishAt: "2026-11-21T01:45:00.000Z",
      weightGrams: 34.2,
      lengthMeters: 11.4,
      timelapse: false,
      printableObjects: [
        { id: 1, name: "desk-rear-edge-jig.stl", skipped: false },
        { id: 2, name: "alignment-pin.stl", skipped: false },
      ],
    },
    thermals: {
      nozzle: { actualC: 215, targetC: 215 },
      bed: { actualC: 70, targetC: 70 },
      chamber: { actualC: 36, targetC: null },
      history: [
        {
          timestampMs: 1795222680000,
          nozzleActualC: 214,
          nozzleTargetC: 215,
          bedActualC: 70,
          bedTargetC: 70,
          chamberActualC: 35,
        },
        {
          timestampMs: 1795222800000,
          nozzleActualC: 215,
          nozzleTargetC: 215,
          bedActualC: 70,
          bedTargetC: 70,
          chamberActualC: 36,
        },
      ],
    },
    fans: {
      coolingPercent: 80,
      auxPercent: 40,
      chamberPercent: 50,
      heatbreakPercent: 100,
    },
    lighting: {
      chamberLight: true,
    },
    speed: {
      profile: "standard",
      modifierPercent: 100,
    },
    filament: {
      extruderLoaded: true,
      amsUnits: [],
      externalSpool: {
        id: "external",
        label: "External Spool",
        material: "PETG",
        colorHex: "#38bdf8",
        remainingPercent: null,
        active: true,
        empty: false,
        external: true,
      },
    },
    alerts: [],
    media: {
      hasCamera: true,
      hasCoverImage: true,
      hasPickImage: true,
      cameraUpdatedAt: "2026-11-21T00:59:58.000Z",
      cameraStale: false,
      cameraRevision: 1,
      coverUpdatedAt: "2026-11-21T00:30:00.000Z",
    },
    capabilities: {
      canPause: true,
      canResume: false,
      canStop: true,
      canSetTemps: true,
      canSetFans: true,
      canSetLight: true,
      canSetSpeed: true,
      canJog: false,
      canSkipObjects: true,
    },
    ...overrides,
  };
}

describe("PrinterPanel", () => {
  it("renders slicer telemetry, swaps camera and 3D plate preview, and requires confirmation to stop a print", async () => {
    mockRunCommand.mockReset();
    mockRunCommand.mockResolvedValue(Exit.succeed(makePrinter()));
    mockNavigate.mockReset();
    const printer = makePrinter();
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [printer],
      sessions: [],
      revision: 1,
    };

    await using screen = await render(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );

    await expect
      .element(screen.getByText("desk-rear-edge-jig", { exact: true }), { timeout: 2500 })
      .toBeVisible();
    await expect
      .element(screen.getByText("desk-rear-edge-jig.stl"), { timeout: 2500 })
      .toBeVisible();
    await expect.element(screen.getByText(/42%/), { timeout: 2500 }).toBeVisible();
    await expect.element(screen.getByText("215°C"), { timeout: 2500 }).toBeVisible();
    await expect.element(screen.getByText("70°C"), { timeout: 2500 }).toBeVisible();

    // Swap viewport from Camera to 3D Plate Preview via PiP button.
    const pipButton = screen.getByRole("button", { name: "Switch to 3D plate cover preview" });
    await userEvent.click(pipButton);
    await expect.element(screen.getByText("3D Plate Preview"), { timeout: 2500 }).toBeVisible();

    // Stop print requires AlertDialog confirmation before sending an action.
    const stopButton = screen.getByRole("button", { name: "Stop" });
    await userEvent.click(stopButton);
    await expect.element(page.getByText("Stop active print?"), { timeout: 2500 }).toBeVisible();
    expect(mockRunCommand).not.toHaveBeenCalled();

    const confirmStop = page.getByRole("button", { name: "Stop print" });
    await userEvent.click(confirmStop);
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          printerId: "p1s-studio",
          action: {
            kind: "stop",
            expectedJobFileName: "desk-rear-edge-jig.gcode.3mf",
          },
        },
      }),
    );
  });

  it("locks axis jogging while printing and unlocks it when idle after flipping the safety switch", async () => {
    mockRunCommand.mockReset();
    mockRunCommand.mockResolvedValue(Exit.succeed(makePrinter()));
    mockNavigate.mockReset();
    const idlePrinter = makePrinter({
      job: {
        status: "idle",
        stage: "idle",
        stageLabel: "Idle",
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
      capabilities: {
        canPause: false,
        canResume: false,
        canStop: false,
        canSetTemps: true,
        canSetFans: true,
        canSetLight: true,
        canSetSpeed: false,
        canJog: true,
        canSkipObjects: false,
      },
    });
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [idlePrinter],
      sessions: [],
      revision: 2,
    };

    await using screen = await render(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );

    const controlsTab = screen.getByRole("button", { name: "Controls" });
    await userEvent.click(controlsTab);

    const jogYPlus = screen.getByRole("button", { name: "Move Y +1 mm" });
    await expect.element(jogYPlus).toBeDisabled();

    const unlockSwitch = screen.getByRole("switch", { name: "Unlock motion controls" });
    await userEvent.click(unlockSwitch);
    await expect.element(jogYPlus).toBeEnabled();

    await userEvent.click(jogYPlus);
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          printerId: "p1s-studio",
          action: { kind: "moveAxis", axis: "Y", distanceMm: 1 },
        },
      }),
    );
  });
});
