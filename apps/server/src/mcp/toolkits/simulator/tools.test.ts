import { expect, it } from "@effect/vitest";

import { SimulatorToolkit } from "./tools.ts";

it("exports the complete simulator control surface", () => {
  expect(Object.values(SimulatorToolkit.tools).map((tool) => tool.name)).toEqual([
    "simulator_open",
    "simulator_tap",
    "simulator_swipe",
    "simulator_type",
    "simulator_screenshot",
    "simulator_video_start",
    "simulator_video_stop",
    "simulator_logs",
    "simulator_metrics",
    "simulator_close",
  ]);
});
