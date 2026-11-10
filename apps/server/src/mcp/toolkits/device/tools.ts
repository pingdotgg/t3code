import {
  OrchestratorMcpFailure,
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  DeviceService.DeviceService,
];

const DeviceToolFailure = Schema.Union([DeviceToolError, OrchestratorMcpFailure]);

const DeviceListTool = Tool.make("device_list", {
  description:
    "List iOS Simulators and Android Emulators on every device host, what each host can run, and what is open in this thread's Device panel. Call before `device_open` when you do not know a device id.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceToolListResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeviceOpenTool = Tool.make("device_open", {
  description:
    "Open a simulator or emulator for this thread. Pass `deviceId` and `hostId` from `device_list`. Boots it if needed and shows it in the user's Device panel. Returns the `agent-device` CLI call pinned to that device. Drive the device with that CLI.",
  parameters: DeviceToolOpenInput,
  success: DeviceToolOpenResult,
  failure: DeviceToolFailure,
  dependencies: [
    ...dependencies,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    // The thread's project can name the EAS project a cloud device runs under.
    ProjectService.ProjectService,
  ],
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make("device_screenshot", {
  description:
    "Get a PNG of an open device's screen. For taps and text, use the `agent-device` CLI.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceCloseTool = Tool.make("device_close", {
  description:
    "Remove a device from this thread's Device panel. `shutdown=true` also turns it off.",
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceStandardToolkit = Toolkit.make(DeviceListTool, DeviceOpenTool, DeviceCloseTool);

export const DeviceScreenshotToolkit = Toolkit.make(DeviceScreenshotTool);

export const DeviceToolkit = Toolkit.make(
  DeviceListTool,
  DeviceOpenTool,
  DeviceScreenshotTool,
  DeviceCloseTool,
);
