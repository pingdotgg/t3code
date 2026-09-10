import {
  SimulatorActionReceipt,
  SimulatorArtifact,
  SimulatorCloseInput,
  SimulatorLogsInput,
  SimulatorMetrics,
  SimulatorMetricsInput,
  SimulatorOpenInput,
  SimulatorScreenshotInput,
  SimulatorSession,
  SimulatorSwipeInput,
  SimulatorTapInput,
  SimulatorToolkitError,
  SimulatorTypeInput,
  SimulatorVideoStartInput,
  SimulatorVideoStartResult,
} from "@t3tools/contracts";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SimulatorHost from "../../../simulator/SimulatorHost.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, SimulatorHost.SimulatorHost];

const mutating = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true) as T;

const SimulatorOpenTool = mutating(
  Tool.make("simulator_open", {
    description:
      "Open and boot an iOS Simulator session on this macOS host. Optionally install and launch an app bundle.",
    parameters: SimulatorOpenInput,
    success: SimulatorSession,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Open iOS Simulator"),
);

const SimulatorTapTool = mutating(
  Tool.make("simulator_tap", {
    description:
      "Tap screen coordinates in the active iOS Simulator. Coordinates are macOS screen points and require Accessibility permission.",
    parameters: SimulatorTapInput,
    success: SimulatorActionReceipt,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Tap iOS Simulator"),
);

const SimulatorSwipeTool = mutating(
  Tool.make("simulator_swipe", {
    description: "Swipe between two macOS screen points in the active iOS Simulator.",
    parameters: SimulatorSwipeInput,
    success: SimulatorActionReceipt,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Swipe iOS Simulator"),
);

const SimulatorTypeTool = mutating(
  Tool.make("simulator_type", {
    description: "Type literal text into the focused iOS Simulator control.",
    parameters: SimulatorTypeInput,
    success: SimulatorActionReceipt,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Type in iOS Simulator"),
);

const SimulatorScreenshotTool = Tool.make("simulator_screenshot", {
  description: "Capture a PNG screenshot and return its hashed artifact path.",
  parameters: SimulatorScreenshotInput,
  success: SimulatorArtifact,
  failure: SimulatorToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot iOS Simulator")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const SimulatorVideoStartTool = mutating(
  Tool.make("simulator_video_start", {
    description: "Start recording the active iOS Simulator display to an MP4 artifact.",
    parameters: SimulatorVideoStartInput,
    success: SimulatorVideoStartResult,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Start Simulator video"),
);

const SimulatorVideoStopTool = mutating(
  Tool.make("simulator_video_stop", {
    description: "Stop the active Simulator recording and return the finalized MP4 artifact.",
    parameters: SimulatorCloseInput,
    success: SimulatorArtifact,
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Stop Simulator video"),
);

const SimulatorLogsTool = Tool.make("simulator_logs", {
  description: "Capture recent unified logs from the iOS Simulator as a bounded artifact.",
  parameters: SimulatorLogsInput,
  success: SimulatorArtifact,
  failure: SimulatorToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Read Simulator logs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const SimulatorMetricsTool = Tool.make("simulator_metrics", {
  description: "Sample CPU and memory metrics from the iOS Simulator host.",
  parameters: SimulatorMetricsInput,
  success: SimulatorMetrics,
  failure: SimulatorToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Read Simulator metrics")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const SimulatorCloseTool = mutating(
  Tool.make("simulator_close", {
    description:
      "Close a Simulator session and stop its owned recording process. Artifact files remain available for review.",
    parameters: SimulatorCloseInput,
    success: Schema.Struct({}),
    failure: SimulatorToolkitError,
    dependencies,
  }).annotate(Tool.Title, "Close iOS Simulator"),
);

export const SimulatorToolkit = Toolkit.make(
  SimulatorOpenTool,
  SimulatorTapTool,
  SimulatorSwipeTool,
  SimulatorTypeTool,
  SimulatorScreenshotTool,
  SimulatorVideoStartTool,
  SimulatorVideoStopTool,
  SimulatorLogsTool,
  SimulatorMetricsTool,
  SimulatorCloseTool,
);
