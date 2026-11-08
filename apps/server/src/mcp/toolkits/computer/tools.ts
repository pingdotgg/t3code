import {
  ComputerActInput,
  ComputerScreenshotInput,
  ComputerScreenshotResult,
  ComputerStopInput,
  ComputerUseError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUse from "../../../computer/ComputerUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUse.ComputerUse,
];

const ComputerToolFailure = Schema.Union([ComputerUseError, OrchestratorMcpFailure]);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "See the native desktop of the machine running this T3 environment (KDE Plasma), outside the browser preview. The first call asks the user, in a system dialog, to allow control; wait for it. Then act with `computer_act` in this image's pixels. Screenshot again after acting.",
  parameters: ComputerScreenshotInput,
  success: ComputerScreenshotResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerActTool = Tool.make("computer_act", {
  description:
    "Click, drag, scroll, type or press keys on the desktop from the last `computer_screenshot`. Coordinates are pixels in that image.",
  parameters: ComputerActInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Control desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ComputerStopTool = Tool.make("computer_stop", {
  description: "End control of the desktop when you are done with it.",
  parameters: ComputerStopInput,
  success: Schema.Struct({ stopped: Schema.Boolean }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Stop desktop control")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerStandardToolkit = Toolkit.make(ComputerActTool, ComputerStopTool);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);

export const ComputerToolkit = Toolkit.make(
  ComputerScreenshotTool,
  ComputerActTool,
  ComputerStopTool,
);
