import {
  OrchestratorMcpFailure,
  PrinterToolError,
  PrinterToolListResult,
  PrinterToolOpenResult,
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

const PrinterListTool = Tool.make("printer_list", {
  description:
    "List configured 3D printers, their online and job status, and which ones are open in this thread's Printer panel.",
  parameters: Schema.Struct({
    refresh: Schema.optional(
      Schema.Boolean.annotate({
        description: "Force a fresh poll from each printer. Default true.",
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
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PrinterOpenTool = Tool.make("printer_open", {
  description:
    "Open a 3D printer in this thread's Printer panel so the user can watch live camera, thermals, and print progress.",
  parameters: PrinterToolTargetInput,
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

const PrinterStatusTool = Tool.make("printer_status", {
  description:
    "Read live 3D printer telemetry: job progress, layer, stage, nozzle/bed temps, fans, AMS/spool, objects, alerts, and freshness.",
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
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PrinterCameraSnapshotTool = Tool.make("printer_camera_snapshot", {
  description:
    "Capture a live camera frame from a 3D printer (never slicer cover art), with capturedAt timestamp and stale flag.",
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
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const PrinterCloseTool = Tool.make("printer_close", {
  description:
    "Remove a 3D printer from this thread's Printer panel. Only closes the panel view; never stops a print.",
  parameters: PrinterToolTargetInput,
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
