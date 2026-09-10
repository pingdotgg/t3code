import * as Effect from "effect/Effect";
import { SimulatorToolkitError } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SimulatorHost from "../../../simulator/SimulatorHost.ts";
import { SimulatorToolkit } from "./tools.ts";

const requireCapability = (): Effect.Effect<
  SimulatorHost.SimulatorHostShape,
  SimulatorToolkitError,
  McpInvocationContext.McpInvocationContext | SimulatorHost.SimulatorHost
> =>
  Effect.gen(function* () {
    yield* McpInvocationContext.requireMcpCapability("simulator").pipe(
      Effect.mapError(
        (error) => new SimulatorToolkitError({ code: "unsupported_host", detail: error.message }),
      ),
    );
    return yield* SimulatorHost.SimulatorHost;
  });

const handlers = {
  simulator_open: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.open(input);
    }),
  simulator_tap: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.tap(input);
    }),
  simulator_swipe: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.swipe(input);
    }),
  simulator_type: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.typeText(input);
    }),
  simulator_screenshot: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.screenshot(input);
    }),
  simulator_video_start: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.videoStart(input);
    }),
  simulator_video_stop: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.videoStop(input);
    }),
  simulator_logs: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.logs(input);
    }),
  simulator_metrics: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      return yield* host.metrics(input);
    }),
  simulator_close: (input) =>
    Effect.gen(function* () {
      const host = yield* requireCapability();
      yield* host.close(input);
      return {};
    }),
} satisfies Parameters<typeof SimulatorToolkit.toLayer>[0];

export const SimulatorToolkitHandlersLive = SimulatorToolkit.toLayer(handlers);
