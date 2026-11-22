import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ElectronicsCircuitModel,
  type ElectronicsServiceState,
  type ElectronicsSimulationResult,
  type ElectronicsTracePathResult,
  type ElectronicsValidationReport,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ElectronicsPanel } from "./ElectronicsPanel";

const SAMPLE_MODEL: ElectronicsCircuitModel = {
  format: "kicad_sch",
  filePath: "boards/power.kicad_sch",
  title: "Sensor Power & Divider",
  layers: ["schematic", "wire"],
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 70 },
  components: [
    {
      ref: "U1",
      value: "AMS1117-3.3",
      kind: "ic",
      footprint: "SOT-223",
      x: 35,
      y: 30,
      rotation: 0,
      pins: [
        { number: "1", name: "VIN", electricalType: "power_in", net: "+5V", x: 25, y: 30 },
        { number: "2", name: "GND", electricalType: "power_in", net: "GND", x: 35, y: 40 },
        { number: "3", name: "VOUT", electricalType: "power_out", net: "+3V3", x: 45, y: 30 },
      ],
    },
    {
      ref: "R1",
      value: "10k",
      kind: "resistor",
      footprint: "R_0603",
      x: 65,
      y: 30,
      rotation: 0,
      pins: [
        { number: "1", electricalType: "passive", net: "+3V3", x: 58, y: 30 },
        { number: "2", electricalType: "passive", net: "VSENSE", x: 72, y: 30 },
      ],
    },
  ],
  nets: [
    {
      name: "+5V",
      isPower: true,
      isGround: false,
      pins: [{ ref: "U1", pin: "1", pinName: "VIN", electricalType: "power_in" }],
    },
    {
      name: "+3V3",
      isPower: true,
      isGround: false,
      pins: [
        { ref: "U1", pin: "3", pinName: "VOUT", electricalType: "power_out" },
        { ref: "R1", pin: "1", electricalType: "passive" },
      ],
    },
    {
      name: "VSENSE",
      isPower: false,
      isGround: false,
      pins: [{ ref: "R1", pin: "2", electricalType: "passive" }],
    },
    {
      name: "GND",
      isPower: false,
      isGround: true,
      pins: [{ ref: "U1", pin: "2", pinName: "GND", electricalType: "power_in" }],
    },
  ],
  wires: [{ x1: 45, y1: 30, x2: 58, y2: 30, layer: "wire", net: "+3V3" }],
  vias: [],
  junctions: [],
  noConnects: [],
  labels: [{ text: "+3V3", kind: "local", x: 51, y: 28 }],
  boardOutline: [],
  bom: [
    { value: "AMS1117-3.3", footprint: "SOT-223", kind: "ic", refs: ["U1"], quantity: 1 },
    { value: "10k", footprint: "R_0603", kind: "resistor", refs: ["R1"], quantity: 1 },
  ],
  parseWarnings: [],
};

const SAMPLE_TRACE: ElectronicsTracePathResult = {
  filePath: "boards/power.kicad_sch",
  from: "U1.VOUT",
  to: "VSENSE",
  connected: true,
  fromNets: ["+3V3"],
  toNets: ["VSENSE"],
  hops: [
    { kind: "net", name: "+3V3" },
    {
      kind: "component",
      name: "R1",
      value: "10k",
      fromPin: "1",
      toPin: "2",
      componentKind: "resistor",
    },
    { kind: "net", name: "VSENSE" },
  ],
  highlightedNets: ["+3V3", "VSENSE"],
  highlightedComponents: ["U1", "R1"],
  estimatedResistanceOhms: 10000,
  warnings: [],
};

const SAMPLE_VALIDATION: ElectronicsValidationReport = {
  filePath: "boards/power.kicad_sch",
  format: "kicad_sch",
  passed: true,
  errorCount: 0,
  warningCount: 1,
  infoCount: 1,
  enginesUsed: ["builtin"],
  notes: [],
  issues: [
    {
      id: "w-1",
      code: "single_pin_net",
      severity: "warning",
      source: "builtin",
      message: 'Named net "VSENSE" only connects to a single pin (R1.2).',
      net: "VSENSE",
      refs: ["R1"],
      x: 72,
      y: 30,
    },
    {
      id: "i-1",
      code: "missing_decoupling",
      severity: "info",
      source: "builtin",
      message: 'IC U1 uses power rail "+5V" with no decoupling capacitor detected.',
      net: "+5V",
      refs: ["U1"],
      x: 35,
      y: 30,
    },
  ],
  checkedAt: "2026-11-22T05:00:00.000Z",
};

const SAMPLE_SIM: ElectronicsSimulationResult = {
  filePath: "boards/power.kicad_sch",
  kind: "ac_sweep",
  engine: "builtin_mna",
  xAxisLabel: "Frequency",
  xAxisUnit: "Hz",
  xAxisLog: true,
  nodeVoltages: [{ node: "VSENSE", voltageV: 1.65 }],
  componentReadings: [
    { ref: "R1", value: "10k", voltageDropV: 1.65, currentA: 0.000165, powerW: 0.000272 },
  ],
  series: [
    {
      label: "|V(VSENSE)|",
      unit: "dB",
      points: [
        { x: 10, y: 0, phaseDeg: -1 },
        { x: 1590, y: -3.01, phaseDeg: -45 },
        { x: 100000, y: -36, phaseDeg: -89 },
      ],
    },
  ],
  metrics: [{ name: "-3 dB Cutoff", value: 1591.5, unit: "Hz" }],
  notes: [],
  simulatedAt: "2026-11-22T05:00:00.000Z",
};

let mockState: ElectronicsServiceState = {
  toolchain: {
    enabled: true,
    allowExternalTools: true,
    agentAccessEnabled: true,
    kicadCli: { name: "kicad-cli", available: false },
    ngspice: { name: "ngspice", available: false },
    checkedAt: "2026-11-22T05:00:00.000Z",
  },
  sessions: [],
};
const stateListeners = new Set<() => void>();
function emitMockState(next: ElectronicsServiceState) {
  mockState = next;
  for (const listener of stateListeners) listener();
}

vi.mock("~/state/electronics", () => ({
  electronicsEnvironment: {
    listFiles: "listFiles",
    inspect: "inspect",
    tracePath: "tracePath",
    validate: "validate",
    simulate: "simulate",
  },
  useElectronicsState: () => {
    const state = useSyncExternalStore(
      (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      () => mockState,
    );
    return {
      state,
      loaded: true,
      error: null,
      refresh: vi.fn(),
    };
  },
}));

const simControl: {
  delayNext: boolean;
  resolve: ((value: unknown) => void) | null;
} = {
  delayNext: false,
  resolve: null,
};

function resolveDeferredSim(value: unknown) {
  simControl.resolve?.(value);
  simControl.resolve = null;
}

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (cmd: string) => async (payload?: { input?: { filePath?: string } }) => {
    switch (cmd) {
      case "listFiles":
        return Exit.succeed({
          files: [
            {
              relativePath: "boards/power.kicad_sch",
              name: "power.kicad_sch",
              format: "kicad_sch",
              sizeBytes: 2048,
            },
            {
              relativePath: "boards/filter.cir",
              name: "filter.cir",
              format: "spice",
              sizeBytes: 512,
            },
          ],
          toolchain: mockState.toolchain,
        });
      case "inspect":
        return Exit.succeed({
          ...SAMPLE_MODEL,
          filePath: payload?.input?.filePath ?? SAMPLE_MODEL.filePath,
          title:
            payload?.input?.filePath === "boards/filter.cir"
              ? "RC Filter Deck"
              : SAMPLE_MODEL.title,
        });
      case "tracePath":
        return Exit.succeed(SAMPLE_TRACE);
      case "validate":
        return Exit.succeed(SAMPLE_VALIDATION);
      case "simulate":
        if (simControl.delayNext) {
          simControl.delayNext = false;
          return await new Promise((resolve) => {
            simControl.resolve = resolve;
          });
        }
        return Exit.succeed(SAMPLE_SIM);
      default:
        return Exit.succeed({});
    }
  },
}));

describe("ElectronicsPanel", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

  it("renders schematic canvas, traces paths, validates ERC issues, simulates Bode sweep, and filters BOM", async () => {
    const screen = await render(
      <div className="h-[720px] w-[720px]">
        <ElectronicsPanel threadRef={threadRef} workspaceRoot="/tmp/hw-project" visible={true} />
      </div>,
    );

    await expect.element(screen.getByText("Sensor Power & Divider")).toBeVisible();
    await expect.element(screen.getByLabelText("Interactive circuit canvas")).toBeVisible();

    // Switch to Path Tracer tab and run trace
    await userEvent.click(screen.getByRole("button", { name: /Path Tracer/i }));
    await userEvent.type(screen.getByPlaceholder(/U1\.VOUT/i), "U1.VOUT");
    await userEvent.type(screen.getByPlaceholder(/R2\.1/i), "VSENSE");
    await userEvent.click(screen.getByRole("button", { name: /Validate Path/i }));
    await expect.element(screen.getByText("Path Connected")).toBeVisible();
    await expect.element(screen.getByText(/10\.00 kΩ/i)).toBeVisible();

    // Switch to Checks tab and run validation
    await userEvent.click(screen.getByRole("button", { name: /Checks/i }));
    await userEvent.click(screen.getByRole("button", { name: /Run Checks/i }));
    await expect.element(screen.getByText("All error checks passed")).toBeVisible();
    await expect.element(screen.getByText(/single_pin_net/i)).toBeVisible();

    // Switch to Simulate tab and run simulation
    await userEvent.click(screen.getByRole("button", { name: /Simulate/i }));
    await userEvent.click(screen.getByRole("button", { name: /Run Simulation/i }));
    await expect.element(screen.getByText(/1\.59 kHz/i)).toBeVisible();

    // Switch to BOM tab and verify part entries
    await userEvent.click(screen.getByRole("button", { name: /BOM/i }));
    await expect.element(screen.getByText("AMS1117-3.3")).toBeVisible();
    await expect.element(screen.getByText("SOT-223")).toBeVisible();
  });

  it("clears running flags and discards stale results when switching files mid-simulation", async () => {
    const screen = await render(
      <div className="h-[720px] w-[720px]">
        <ElectronicsPanel threadRef={threadRef} workspaceRoot="/tmp/hw-project" visible={true} />
      </div>,
    );

    await expect.element(screen.getByText("Sensor Power & Divider")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Simulate/i }));

    simControl.delayNext = true;
    simControl.resolve = null;
    await userEvent.click(screen.getByRole("button", { name: /Run Simulation/i }));
    await expect.element(screen.getByRole("button", { name: /Simulating…/i })).toBeDisabled();

    // Switch files while the first simulation is still in flight
    const fileSelect = screen.getByLabelText("Circuit design file");
    await userEvent.selectOptions(fileSelect, "boards/filter.cir");
    await expect.element(screen.getByText("RC Filter Deck")).toBeVisible();

    // Run button must immediately be re-enabled (not stuck in Simulating…)
    await expect.element(screen.getByRole("button", { name: /Run Simulation/i })).toBeEnabled();

    // Resolving the stale first simulation AND publishing a stale session broadcast for file A
    // must NOT paint file A's result or snap the file selector back from file B to file A
    try {
      emitMockState({
        ...mockState,
        sessions: [
          {
            threadId: ThreadId.make("thread-1"),
            filePath: "boards/power.kicad_sch",
            format: "kicad_sch",
            activeTab: "simulate",
            lastSimulation: SAMPLE_SIM,
            openedAt: "2026-11-22T05:00:00.000Z",
            updatedAt: "2026-11-22T05:01:00.000Z",
          },
        ],
      });
      resolveDeferredSim(Exit.succeed(SAMPLE_SIM));
      await Promise.resolve();
      await Promise.resolve();
      await expect.element(screen.getByText("RC Filter Deck")).toBeVisible();
      await expect.element(screen.getByText(/1\.59 kHz/i)).not.toBeInTheDocument();
    } finally {
      emitMockState({ ...mockState, sessions: [] });
    }
  });
});
