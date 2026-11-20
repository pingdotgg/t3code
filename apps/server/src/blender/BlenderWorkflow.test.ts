import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { liveThreadsLayer } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BlenderWorkflow from "./BlenderWorkflow.ts";

it.effect("shares explicit activation only with the selected thread, until deactivation", () =>
  Effect.gen(function* () {
    const workflow = yield* BlenderWorkflow.BlenderWorkflow;
    const a = ThreadId.make("thread:blender");
    const b = ThreadId.make("thread:unrelated");
    expect(yield* workflow.isActive(a)).toBe(false);
    expect(yield* workflow.setActive(a, true)).toBe(true);
    expect(yield* workflow.isActive(a)).toBe(true);
    expect(yield* workflow.isActive(b)).toBe(false);
    expect(yield* workflow.setActive(a, false)).toBe(false);
    expect(yield* workflow.isActive(a)).toBe(false);
  }).pipe(
    Effect.provide(
      BlenderWorkflow.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            liveThreadsLayer,
            ServerSettings.layerTest({ blender: { enabled: true } }),
          ),
        ),
      ),
    ),
  ),
);
