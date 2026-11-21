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
  loadingEnvironmentIds: new Set<EnvironmentId>(),
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
        loadingEnvironmentIds: mockStateRef.loadingEnvironmentIds,
        unreachableEnvironmentCount: 0,
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
            expectedJobStartedAt: "2026-11-21T00:30:00.000Z",
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

  it("closes the Stop dialog if the active job changes before confirmation and includes expectedJobFileName on skip object", async () => {
    mockRunCommand.mockReset();
    mockRunCommand.mockResolvedValue(Exit.succeed(makePrinter()));
    mockNavigate.mockReset();
    const jobA = makePrinter();
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [jobA],
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

    // Open Stop confirmation bound to jobA.
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await expect.element(page.getByText("Stop active print?"), { timeout: 2500 }).toBeVisible();

    // Job changes on the printer while dialog is open -> dialog closes cleanly without stopping jobB.
    const jobB = makePrinter({
      job: {
        ...jobA.job,
        fileName: "next-plate.gcode.3mf",
        displayName: "next-plate",
      },
    });
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [jobB],
      sessions: [],
      revision: 2,
    };
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );
    await expect.element(page.getByText("Stop active print?")).not.toBeInTheDocument();
    expect(mockRunCommand).not.toHaveBeenCalled();

    // Reprinting the original filename (A -> B -> A with new startedAt) must NOT revive the stale Stop dialog.
    const jobAReprint = makePrinter({
      job: {
        ...jobA.job,
        startedAt: "2026-11-21T02:00:00.000Z",
      },
    });
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [jobAReprint],
      sessions: [],
      revision: 3,
    };
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );
    await expect.element(page.getByText("Stop active print?")).not.toBeInTheDocument();

    // Direct same-filename reprint without an intermediate job also closes an open Stop dialog via startedAt rotation.
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await expect.element(page.getByText("Stop active print?"), { timeout: 2500 }).toBeVisible();
    const jobAReprint2 = makePrinter({
      job: {
        ...jobA.job,
        startedAt: "2026-11-21T03:00:00.000Z",
      },
    });
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [jobAReprint2],
      sessions: [],
      revision: 4,
    };
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );
    await expect.element(page.getByText("Stop active print?")).not.toBeInTheDocument();

    // Switch back to jobB for skip-object assertion.
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [jobB],
      sessions: [],
      revision: 5,
    };
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-studio", kind: "printer", printerId: "p1s-studio" }}
          visible
        />
      </div>,
    );

    // Skip object confirmation includes expectedJobFileName for the captured job.
    const skipButtons = screen.getByRole("button", { name: "Skip" });
    await userEvent.click(skipButtons.first());
    await expect
      .element(page.getByText("Skip object for rest of print?"), { timeout: 2500 })
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Skip object" }));
    expect(mockRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          printerId: "p1s-studio",
          action: {
            kind: "skipObjects",
            objectIds: [1],
            expectedJobFileName: "next-plate.gcode.3mf",
            expectedJobStartedAt: "2026-11-21T00:30:00.000Z",
          },
        },
      }),
    );
  });

  it("resets motion unlock when switching printers and shows unavailable state for missing pinned printer", async () => {
    mockRunCommand.mockReset();
    mockRunCommand.mockResolvedValue(Exit.succeed(makePrinter()));
    const idleCapabilities = {
      canPause: false,
      canResume: false,
      canStop: false,
      canSetTemps: true,
      canSetFans: true,
      canSetLight: true,
      canSetSpeed: false,
      canJog: true,
      canSkipObjects: false,
    };
    const idleJob = {
      status: "idle" as const,
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
    };
    const printerA = makePrinter({
      id: PrinterId.make("p1s-a"),
      label: "Printer A",
      job: idleJob,
      capabilities: idleCapabilities,
    });
    const printerB = makePrinter({
      id: PrinterId.make("p1s-b"),
      label: "Printer B",
      job: idleJob,
      capabilities: idleCapabilities,
    });
    mockStateRef.current = {
      enabled: true,
      agentAccessEnabled: true,
      mediaBasePath: "/api/printer-media",
      printers: [printerA, printerB],
      sessions: [],
      revision: 3,
    };

    await using screen = await render(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-a", kind: "printer", printerId: "p1s-a" }}
          visible
        />
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Controls" }));
    await userEvent.click(screen.getByRole("switch", { name: "Unlock motion controls" }));
    await expect.element(screen.getByRole("button", { name: "Move Y +1 mm" })).toBeEnabled();

    // Switching to another printer remounts ControlsDeck so motion starts locked again.
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:p1s-b", kind: "printer", printerId: "p1s-b" }}
          visible
        />
      </div>,
    );
    await expect.element(screen.getByRole("button", { name: "Move Y +1 mm" })).toBeDisabled();

    // Pinned missing printer renders unavailable state instead of silently falling back to Printer A.
    await screen.rerender(
      <div style={{ width: 480, height: 820, display: "flex" }}>
        <PrinterPanel
          mode="embedded"
          threadRef={threadRef}
          surface={{ id: "printer:gone", kind: "printer", printerId: "gone" }}
          visible
        />
      </div>,
    );
    await expect.element(screen.getByText("gone is unavailable"), { timeout: 2500 }).toBeVisible();

    // When the pinned environment is still connecting/loading, show a loading state instead of claiming unavailable.
    mockStateRef.loadingEnvironmentIds = new Set([threadRef.environmentId]);
    try {
      await screen.rerender(
        <div style={{ width: 480, height: 820, display: "flex" }}>
          <PrinterPanel
            mode="embedded"
            threadRef={threadRef}
            surface={{
              id: "printer:gone",
              kind: "printer",
              printerId: "gone",
              proxyEnvironmentId: threadRef.environmentId,
            }}
            visible
          />
        </div>,
      );
      await expect.element(screen.getByText("gone is unavailable")).not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("status", { name: "Loading" }), { timeout: 2500 })
        .toBeVisible();
    } finally {
      mockStateRef.loadingEnvironmentIds = new Set();
    }
  });
});
