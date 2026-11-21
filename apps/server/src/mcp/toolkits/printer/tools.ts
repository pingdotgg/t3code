import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PrinterToolError,
  PrinterToolListResult,
  PrinterToolOpenResult,
  PrinterToolPanelTargetInput,
  PrinterToolSnapshotResult,
  PrinterToolStatusResult,
  PrinterToolTargetInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PrinterService from "../../../printer/PrinterService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PrinterService.PrinterService,
];

const PrinterToolFailure = Schema.Union([PrinterToolError, OrchestratorMcpFailure]);

export const PrinterListTool = Tool.make("printer_list", {
  description:
    "List 3D printers locally and across linked T3 Connect environments, their status, and which are open in this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    refresh: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Force a fresh poll. Default refreshes local printers and reads cached linked-peer telemetry; pass true to refresh both.",
      }),
    ),
  }),
  success: PrinterToolListResult,
  failure: PrinterToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List 3D printers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromUnlinkedOutsideClients);

const PrinterOpenTool = Tool.make("printer_open", {
  description:
    "Open a 3D printer (local or via a linked T3 Connect proxy environment) in this thread's Printer panel.",
  parameters: PrinterToolPanelTargetInput,
  success: PrinterToolOpenResult,
  failure: PrinterToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open 3D printer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PrinterStatusTool = Tool.make("printer_status", {
  description:
    "Read live 3D printer telemetry (auto-routing via linked T3 Connect proxy if needed): job, temps, fans, AMS, alerts, freshness.",
  parameters: PrinterToolTargetInput,
  success: PrinterToolStatusResult,
  failure: PrinterToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read 3D printer status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromUnlinkedOutsideClients);

export const PrinterCameraSnapshotTool = Tool.make("printer_camera_snapshot", {
  description:
    "Capture a live camera frame from a 3D printer (auto-routing via linked T3 Connect proxy if needed), with timestamp and stale flag.",
  parameters: PrinterToolTargetInput,
  success: PrinterToolSnapshotResult,
  failure: PrinterToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Capture 3D printer camera")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromUnlinkedOutsideClients);

const PrinterCloseTool = Tool.make("printer_close", {
  description:
    "Remove a 3D printer from this thread's Printer panel. Only closes the panel view; never stops a print.",
  parameters: PrinterToolPanelTargetInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: PrinterToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close 3D printer panel")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PrinterStandardToolkit = Toolkit.make(
  PrinterListTool,
  PrinterOpenTool,
  PrinterStatusTool,
  PrinterCloseTool,
);

export const PrinterSnapshotToolkit = Toolkit.make(PrinterCameraSnapshotTool);

export const PrinterToolkit = Toolkit.make(
  PrinterListTool,
  PrinterOpenTool,
  PrinterStatusTool,
  PrinterCameraSnapshotTool,
  PrinterCloseTool,
);
