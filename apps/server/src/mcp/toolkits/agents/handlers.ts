import { SubAgentError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SubAgentCoordinator, SubAgentCoordinatorLive } from "./SubAgentCoordinator.ts";
import { SubAgentToolkit } from "./tools.ts";

const requireAgentsScope = Effect.fn("SubAgentToolkit.requireAgentsScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("agents")) {
    return yield* new SubAgentError({
      reason: "capability-unavailable",
      description: "This MCP credential does not grant the agents capability.",
    });
  }
  return invocation;
});

const SubAgentToolkitHandlers = SubAgentToolkit.toLayer({
  agent_list: () =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* SubAgentCoordinator;
      return yield* coordinator.list(scope);
    }),
  agent_spawn: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* SubAgentCoordinator;
      return yield* coordinator.spawn(scope, input);
    }),
  agent_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* SubAgentCoordinator;
      return yield* coordinator.send(scope, input);
    }),
  agent_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* SubAgentCoordinator;
      return yield* coordinator.wait(scope, input);
    }),
});

export const SubAgentToolkitHandlersLive = SubAgentToolkitHandlers.pipe(
  Layer.provide(SubAgentCoordinatorLive),
);
