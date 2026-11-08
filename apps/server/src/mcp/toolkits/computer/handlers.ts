import { ComputerUseUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUse from "../../../computer/ComputerUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerScreenshotToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const requireComputerAccess = McpInvocationContext.requireThreadMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new ComputerUseUnavailableError({
        reason:
          "Agent computer control is off for this agent session. Ask the user to turn it on in Settings > Devices; it applies when the agent session next starts, such as in a new thread.",
      }),
  ),
);

const handlers = {
  computer_screenshot: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerAccess;
      const computer = yield* ComputerUse.ComputerUse;
      return yield* computer.screenshot({
        threadId: scope.thread.threadId,
        display: input.display,
      });
    }),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerAccess;
      const computer = yield* ComputerUse.ComputerUse;
      yield* computer.act({ ...input, threadId: scope.thread.threadId });
      return {};
    }),
  ),
  computer_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer").pipe(
        Effect.mapError(
          () => new ComputerUseUnavailableError({ reason: "No desktop control to stop." }),
        ),
      );
      const computer = yield* ComputerUse.ComputerUse;
      return yield* computer.stop({
        threadId: scope.thread.threadId,
        forget: input.forget === true,
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const { computer_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ComputerStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
