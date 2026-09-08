import {
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DeviceService from "../../../device/DeviceService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, DeviceService.DeviceService];

/**
 * Deliberately a small surface: lifecycle, visibility for the user, and one
 * image-returning verb. Driving the device (taps, typing, install, logs)
 * happens through the preconfigured `agent-device` CLI, which has the
 * semantic snapshot model agents need and stays current with its own
 * releases. Wrapping its commands here would only lag behind it.
 */
export const DeviceListTool = Tool.make("device_list", {
  description:
    "List iOS Simulators and Android Emulators on this environment's device hosts, which platforms each host can run, and which devices are already open in this thread's Device panel. Call this before device_open when you do not know a device id.",
  parameters: Schema.Struct({}),
  success: DeviceToolListResult,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DeviceOpenTool = Tool.make("device_open", {
  description:
    "Open a simulator or emulator for this thread: boots it if needed, starts its live stream, and shows it in the user's Device panel so they can watch. Returns the agent-device CLI invocation pinned to the device; drive the device with that CLI afterwards.",
  parameters: DeviceToolOpenInput,
  success: DeviceToolOpenResult,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make("device_screenshot", {
  description:
    "Capture the current screen of an open device as a PNG image. Use it to see what the user sees; for taps and text use the agent-device CLI.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceCloseTool = Tool.make("device_close", {
  description:
    "Remove a device from this thread's Device panel. Pass shutdown=true to also power the simulator or emulator off.",
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never).annotate({
    description: "The device was closed.",
  }),
  failure: DeviceToolError,
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
