import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const ElectronicsDesignFormat = Schema.Literals([
  "kicad_sch",
  "kicad_pcb",
  "spice",
  "circuit_json",
]);
export type ElectronicsDesignFormat = typeof ElectronicsDesignFormat.Type;

export const ElectronicsPinElectricalType = Schema.Literals([
  "input",
  "output",
  "bidirectional",
  "tri_state",
  "passive",
  "power_in",
  "power_out",
  "open_collector",
  "open_emitter",
  "unconnected",
  "unspecified",
]);
export type ElectronicsPinElectricalType = typeof ElectronicsPinElectricalType.Type;

export const ElectronicsComponentKind = Schema.Literals([
  "resistor",
  "capacitor",
  "inductor",
  "diode",
  "transistor",
  "ic",
  "connector",
  "power_source",
  "power_symbol",
  "switch",
  "fuse",
  "crystal",
  "other",
]);
export type ElectronicsComponentKind = typeof ElectronicsComponentKind.Type;

export const ElectronicsPoint = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type ElectronicsPoint = typeof ElectronicsPoint.Type;

export const ElectronicsPin = Schema.Struct({
  number: Schema.String,
  name: Schema.optional(Schema.String),
  electricalType: ElectronicsPinElectricalType,
  net: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  layers: Schema.optional(Schema.Array(Schema.String)),
  padWidth: Schema.optional(Schema.Number),
  padHeight: Schema.optional(Schema.Number),
  padRotation: Schema.optional(Schema.Number),
  padShape: Schema.optional(
    Schema.Literals(["circle", "oval", "rect", "roundrect", "trapezoid", "custom"]),
  ),
});
export type ElectronicsPin = typeof ElectronicsPin.Type;

export const ElectronicsComponent = Schema.Struct({
  ref: Schema.String,
  value: Schema.String,
  kind: ElectronicsComponentKind,
  libId: Schema.optional(Schema.String),
  footprint: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.Int),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  rotation: Schema.optional(Schema.Number),
  layer: Schema.optional(Schema.String),
  pins: Schema.Array(ElectronicsPin),
});
export type ElectronicsComponent = typeof ElectronicsComponent.Type;

export const ElectronicsNetPinRef = Schema.Struct({
  ref: Schema.String,
  pin: Schema.String,
  pinName: Schema.optional(Schema.String),
  electricalType: ElectronicsPinElectricalType,
});
export type ElectronicsNetPinRef = typeof ElectronicsNetPinRef.Type;

export const ElectronicsNet = Schema.Struct({
  name: Schema.String,
  code: Schema.optional(Schema.Int),
  isPower: Schema.Boolean,
  isGround: Schema.Boolean,
  pins: Schema.Array(ElectronicsNetPinRef),
});
export type ElectronicsNet = typeof ElectronicsNet.Type;

export const ElectronicsWireSegment = Schema.Struct({
  x1: Schema.Number,
  y1: Schema.Number,
  x2: Schema.Number,
  y2: Schema.Number,
  layer: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  net: Schema.optional(Schema.String),
});
export type ElectronicsWireSegment = typeof ElectronicsWireSegment.Type;

export const ElectronicsVia = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  size: Schema.Number,
  drill: Schema.optional(Schema.Number),
  net: Schema.optional(Schema.String),
  layers: Schema.optional(Schema.Array(Schema.String)),
});
export type ElectronicsVia = typeof ElectronicsVia.Type;

export const ElectronicsLabelMarker = Schema.Struct({
  text: Schema.String,
  kind: Schema.Literals(["local", "global", "hierarchical", "power"]),
  x: Schema.Number,
  y: Schema.Number,
});
export type ElectronicsLabelMarker = typeof ElectronicsLabelMarker.Type;

export const ElectronicsBomEntry = Schema.Struct({
  value: Schema.String,
  footprint: Schema.optional(Schema.String),
  libId: Schema.optional(Schema.String),
  kind: ElectronicsComponentKind,
  refs: Schema.Array(Schema.String),
  quantity: Schema.Int,
});
export type ElectronicsBomEntry = typeof ElectronicsBomEntry.Type;

export const ElectronicsBounds = Schema.Struct({
  minX: Schema.Number,
  minY: Schema.Number,
  maxX: Schema.Number,
  maxY: Schema.Number,
});
export type ElectronicsBounds = typeof ElectronicsBounds.Type;

export const ElectronicsCircuitModel = Schema.Struct({
  format: ElectronicsDesignFormat,
  filePath: Schema.String,
  title: Schema.optional(Schema.String),
  layers: Schema.Array(Schema.String),
  bounds: ElectronicsBounds,
  components: Schema.Array(ElectronicsComponent),
  nets: Schema.Array(ElectronicsNet),
  wires: Schema.Array(ElectronicsWireSegment),
  vias: Schema.Array(ElectronicsVia),
  junctions: Schema.Array(ElectronicsPoint),
  noConnects: Schema.Array(ElectronicsPoint),
  labels: Schema.Array(ElectronicsLabelMarker),
  boardOutline: Schema.Array(ElectronicsWireSegment),
  bom: Schema.Array(ElectronicsBomEntry),
  parseWarnings: Schema.Array(Schema.String),
});
export type ElectronicsCircuitModel = typeof ElectronicsCircuitModel.Type;

export const ElectronicsPathHop = Schema.Struct({
  kind: Schema.Literals(["net", "component"]),
  name: Schema.String,
  value: Schema.optional(Schema.String),
  fromPin: Schema.optional(Schema.String),
  toPin: Schema.optional(Schema.String),
  componentKind: Schema.optional(ElectronicsComponentKind),
});
export type ElectronicsPathHop = typeof ElectronicsPathHop.Type;

export const ElectronicsTracePathResult = Schema.Struct({
  filePath: Schema.String,
  from: Schema.String,
  to: Schema.optional(Schema.String),
  connected: Schema.Boolean,
  directNet: Schema.optional(Schema.String),
  fromNets: Schema.Array(Schema.String),
  toNets: Schema.Array(Schema.String),
  hops: Schema.Array(ElectronicsPathHop),
  highlightedNets: Schema.Array(Schema.String),
  highlightedComponents: Schema.Array(Schema.String),
  estimatedResistanceOhms: Schema.optional(Schema.Number),
  warnings: Schema.Array(Schema.String),
});
export type ElectronicsTracePathResult = typeof ElectronicsTracePathResult.Type;

export const ElectronicsValidationSeverity = Schema.Literals(["error", "warning", "info"]);
export type ElectronicsValidationSeverity = typeof ElectronicsValidationSeverity.Type;

export const ElectronicsValidationSource = Schema.Literals(["builtin", "kicad_erc", "kicad_drc"]);
export type ElectronicsValidationSource = typeof ElectronicsValidationSource.Type;

export const ElectronicsValidationIssue = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  severity: ElectronicsValidationSeverity,
  source: ElectronicsValidationSource,
  message: Schema.String,
  net: Schema.optional(Schema.String),
  refs: Schema.Array(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
});
export type ElectronicsValidationIssue = typeof ElectronicsValidationIssue.Type;

export const ElectronicsValidationReport = Schema.Struct({
  filePath: Schema.String,
  format: ElectronicsDesignFormat,
  passed: Schema.Boolean,
  errorCount: Schema.Int,
  warningCount: Schema.Int,
  infoCount: Schema.Int,
  enginesUsed: Schema.Array(ElectronicsValidationSource),
  notes: Schema.Array(Schema.String),
  issues: Schema.Array(ElectronicsValidationIssue),
  checkedAt: Schema.String,
});
export type ElectronicsValidationReport = typeof ElectronicsValidationReport.Type;

export const ElectronicsSimulationKind = Schema.Literals(["dc_op", "ac_sweep", "transient"]);
export type ElectronicsSimulationKind = typeof ElectronicsSimulationKind.Type;

export const ElectronicsSimulationEngine = Schema.Literals(["ngspice", "builtin_mna"]);
export type ElectronicsSimulationEngine = typeof ElectronicsSimulationEngine.Type;

export const ElectronicsSimulationNodeVoltage = Schema.Struct({
  node: Schema.String,
  voltageV: Schema.Number,
});
export type ElectronicsSimulationNodeVoltage = typeof ElectronicsSimulationNodeVoltage.Type;

export const ElectronicsSimulationComponentReading = Schema.Struct({
  ref: Schema.String,
  value: Schema.String,
  voltageDropV: Schema.Number,
  currentA: Schema.Number,
  powerW: Schema.Number,
});
export type ElectronicsSimulationComponentReading =
  typeof ElectronicsSimulationComponentReading.Type;

export const ElectronicsSimulationTraceSeries = Schema.Struct({
  label: Schema.String,
  unit: Schema.String,
  points: Schema.Array(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      phaseDeg: Schema.optional(Schema.Number),
    }),
  ),
});
export type ElectronicsSimulationTraceSeries = typeof ElectronicsSimulationTraceSeries.Type;

export const ElectronicsSimulationMetric = Schema.Struct({
  name: Schema.String,
  value: Schema.Number,
  unit: Schema.String,
});
export type ElectronicsSimulationMetric = typeof ElectronicsSimulationMetric.Type;

export const ElectronicsSimulationResult = Schema.Struct({
  filePath: Schema.String,
  kind: ElectronicsSimulationKind,
  engine: ElectronicsSimulationEngine,
  xAxisLabel: Schema.String,
  xAxisUnit: Schema.String,
  xAxisLog: Schema.Boolean,
  nodeVoltages: Schema.Array(ElectronicsSimulationNodeVoltage),
  componentReadings: Schema.Array(ElectronicsSimulationComponentReading),
  series: Schema.Array(ElectronicsSimulationTraceSeries),
  metrics: Schema.Array(ElectronicsSimulationMetric),
  notes: Schema.Array(Schema.String),
  simulatedAt: Schema.String,
});
export type ElectronicsSimulationResult = typeof ElectronicsSimulationResult.Type;

export const ElectronicsToolBinaryStatus = Schema.Struct({
  name: Schema.Literals(["kicad-cli", "ngspice"]),
  available: Schema.Boolean,
  path: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type ElectronicsToolBinaryStatus = typeof ElectronicsToolBinaryStatus.Type;

export const ElectronicsToolchainStatus = Schema.Struct({
  enabled: Schema.Boolean,
  allowExternalTools: Schema.Boolean,
  agentAccessEnabled: Schema.Boolean,
  kicadCli: ElectronicsToolBinaryStatus,
  ngspice: ElectronicsToolBinaryStatus,
  checkedAt: Schema.String,
});
export type ElectronicsToolchainStatus = typeof ElectronicsToolchainStatus.Type;

export const ElectronicsWorkspaceFile = Schema.Struct({
  relativePath: Schema.String,
  name: Schema.String,
  format: ElectronicsDesignFormat,
  sizeBytes: Schema.Int,
});
export type ElectronicsWorkspaceFile = typeof ElectronicsWorkspaceFile.Type;

export const ElectronicsPanelTab = Schema.Literals([
  "canvas",
  "trace",
  "checks",
  "simulate",
  "bom",
]);
export type ElectronicsPanelTab = typeof ElectronicsPanelTab.Type;

export const ElectronicsThreadSession = Schema.Struct({
  threadId: ThreadId,
  filePath: Schema.String,
  format: ElectronicsDesignFormat,
  activeTab: ElectronicsPanelTab,
  selectedNet: Schema.optional(Schema.String),
  lastTrace: Schema.optional(ElectronicsTracePathResult),
  lastValidation: Schema.optional(ElectronicsValidationReport),
  lastSimulation: Schema.optional(ElectronicsSimulationResult),
  openedAt: Schema.String,
  panelOpenedAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type ElectronicsThreadSession = typeof ElectronicsThreadSession.Type;

export const ElectronicsServiceState = Schema.Struct({
  toolchain: ElectronicsToolchainStatus,
  sessions: Schema.Array(ElectronicsThreadSession),
});
export type ElectronicsServiceState = typeof ElectronicsServiceState.Type;

export class ElectronicsError extends Schema.TaggedError<ElectronicsError>()("ElectronicsError", {
  code: Schema.Literals([
    "disabled",
    "not_found",
    "invalid_path",
    "unsupported_format",
    "parse_failed",
    "simulation_failed",
    "toolchain_unavailable",
    "internal",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// RPC payloads
export const ElectronicsListFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ElectronicsListFilesInput = typeof ElectronicsListFilesInput.Type;

export const ElectronicsListFilesResult = Schema.Struct({
  files: Schema.Array(ElectronicsWorkspaceFile),
  toolchain: ElectronicsToolchainStatus,
});
export type ElectronicsListFilesResult = typeof ElectronicsListFilesResult.Type;

export const ElectronicsInspectInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
});
export type ElectronicsInspectInput = typeof ElectronicsInspectInput.Type;

export const ElectronicsTracePathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  from: TrimmedNonEmptyString,
  to: Schema.optional(TrimmedNonEmptyString),
  traversePassives: Schema.optional(Schema.Boolean),
  maxHops: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
});
export type ElectronicsTracePathInput = typeof ElectronicsTracePathInput.Type;

export const ElectronicsValidateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  useExternalToolchain: Schema.optional(Schema.Boolean),
});
export type ElectronicsValidateInput = typeof ElectronicsValidateInput.Type;

export const ElectronicsPositiveFiniteNumber = Schema.Finite.check(Schema.isGreaterThan(0));

export const ElectronicsSimulateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  kind: Schema.optional(ElectronicsSimulationKind),
  outputNode: Schema.optional(TrimmedNonEmptyString),
  startFreqHz: Schema.optional(ElectronicsPositiveFiniteNumber),
  stopFreqHz: Schema.optional(ElectronicsPositiveFiniteNumber),
  pointsPerDecade: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 50 }))),
  stopTimeSeconds: Schema.optional(ElectronicsPositiveFiniteNumber),
  stepTimeSeconds: Schema.optional(ElectronicsPositiveFiniteNumber),
  useExternalToolchain: Schema.optional(Schema.Boolean),
});
export type ElectronicsSimulateInput = typeof ElectronicsSimulateInput.Type;

export const ElectronicsOpenPanelInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  activeTab: Schema.optional(ElectronicsPanelTab),
  selectedNet: Schema.optional(TrimmedString),
});
export type ElectronicsOpenPanelInput = typeof ElectronicsOpenPanelInput.Type;

export const ElectronicsClosePanelInput = Schema.Struct({
  threadId: ThreadId,
});
export type ElectronicsClosePanelInput = typeof ElectronicsClosePanelInput.Type;

// Compact MCP tool schemas
export const ElectronicsToolListResult = Schema.Struct({
  files: Schema.Array(ElectronicsWorkspaceFile),
  openFilePath: Schema.optional(Schema.String),
  toolchain: Schema.Struct({
    kicadCli: Schema.Boolean,
    kicadVersion: Schema.optional(Schema.String),
    ngspice: Schema.Boolean,
    ngspiceVersion: Schema.optional(Schema.String),
  }),
});
export type ElectronicsToolListResult = typeof ElectronicsToolListResult.Type;

export const ElectronicsToolInspectResult = Schema.Struct({
  filePath: Schema.String,
  format: ElectronicsDesignFormat,
  title: Schema.optional(Schema.String),
  componentCount: Schema.Int,
  netCount: Schema.Int,
  powerNets: Schema.Array(Schema.String),
  groundNets: Schema.Array(Schema.String),
  components: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      value: Schema.String,
      kind: ElectronicsComponentKind,
      footprint: Schema.optional(Schema.String),
      pins: Schema.Array(
        Schema.Struct({
          number: Schema.String,
          name: Schema.optional(Schema.String),
          type: ElectronicsPinElectricalType,
          net: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  nets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      isPower: Schema.Boolean,
      isGround: Schema.Boolean,
      pins: Schema.Array(Schema.String),
    }),
  ),
  bom: Schema.Array(ElectronicsBomEntry),
  parseWarnings: Schema.Array(Schema.String),
});
export type ElectronicsToolInspectResult = typeof ElectronicsToolInspectResult.Type;

export const ElectronicsToolOpenResult = Schema.Struct({
  filePath: Schema.String,
  format: ElectronicsDesignFormat,
  activeTab: ElectronicsPanelTab,
  componentCount: Schema.Int,
  netCount: Schema.Int,
});
export type ElectronicsToolOpenResult = typeof ElectronicsToolOpenResult.Type;
