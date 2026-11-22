import {
  ElectronicsError,
  ElectronicsPanelTab,
  ElectronicsPositiveFiniteNumber,
  ElectronicsSimulationKind,
  ElectronicsSimulationResult,
  ElectronicsToolInspectResult,
  ElectronicsToolListResult,
  ElectronicsToolOpenResult,
  ElectronicsTracePathResult,
  ElectronicsValidationReport,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ElectronicsService from "../../../electronics/ElectronicsService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  ServerSettings.ServerSettingsService,
  ElectronicsService.ElectronicsService,
];

const ElectronicsToolFailure = Schema.Union([ElectronicsError, OrchestratorMcpFailure]);

const ElectronicsListTool = Tool.make("electronics_list", {
  description:
    "List workspace circuit files (.kicad_sch, .kicad_pcb, .cir/.spice, *.circuit.json), open panel file, and kicad-cli/ngspice status.",
  parameters: Schema.Struct({
    refreshToolchain: Schema.optional(Schema.Boolean),
  }),
  success: ElectronicsToolListResult,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List electronics files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ElectronicsOpenTool = Tool.make("electronics_open", {
  description:
    "Open a circuit file in this thread's Electronics panel so the user sees the same schematic, PCB, or simulation view.",
  parameters: Schema.Struct({
    filePath: TrimmedNonEmptyString,
    activeTab: Schema.optional(ElectronicsPanelTab),
    selectedNet: Schema.optional(Schema.String),
  }),
  success: ElectronicsToolOpenResult,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open electronics panel")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ElectronicsInspectTool = Tool.make("electronics_inspect", {
  description:
    "Parse a KiCad schematic/PCB, SPICE netlist, or Circuit JSON into components, pins, nets, power rails, and BOM.",
  parameters: Schema.Struct({
    filePath: TrimmedNonEmptyString,
  }),
  success: ElectronicsToolInspectResult,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Inspect circuit")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ElectronicsTracePathTool = Tool.make("electronics_trace_path", {
  description:
    "Validate electrical path between pins, components, or nets (e.g. U1.VOUT to J1.1), directly or through series passives.",
  parameters: Schema.Struct({
    filePath: TrimmedNonEmptyString,
    from: TrimmedNonEmptyString,
    to: Schema.optional(TrimmedNonEmptyString),
    traversePassives: Schema.optional(Schema.Boolean),
    maxHops: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
  }),
  success: ElectronicsTracePathResult,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Trace circuit path")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ElectronicsValidateTool = Tool.make("electronics_validate", {
  description:
    "Run built-in electrical/layout checks (shorts, floating pins, conflicts, unrouted nets) plus kicad-cli ERC/DRC if installed.",
  parameters: Schema.Struct({
    filePath: TrimmedNonEmptyString,
    useExternalToolchain: Schema.optional(Schema.Boolean),
  }),
  success: ElectronicsValidationReport,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Validate circuit")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ElectronicsSimulateTool = Tool.make("electronics_simulate", {
  description:
    "Simulate DC operating point, AC Bode sweep, or transient response via ngspice or built-in linear MNA solver.",
  parameters: Schema.Struct({
    filePath: TrimmedNonEmptyString,
    kind: Schema.optional(ElectronicsSimulationKind),
    outputNode: Schema.optional(TrimmedNonEmptyString),
    startFreqHz: Schema.optional(ElectronicsPositiveFiniteNumber),
    stopFreqHz: Schema.optional(ElectronicsPositiveFiniteNumber),
    stopTimeSeconds: Schema.optional(ElectronicsPositiveFiniteNumber),
  }),
  success: ElectronicsSimulationResult,
  failure: ElectronicsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Simulate circuit")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ElectronicsToolkit = Toolkit.make(
  ElectronicsListTool,
  ElectronicsOpenTool,
  ElectronicsInspectTool,
  ElectronicsTracePathTool,
  ElectronicsValidateTool,
  ElectronicsSimulateTool,
);
