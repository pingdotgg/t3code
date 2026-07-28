import { BranchThreadError, DelegateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegateCoordinator, DelegateCoordinatorLive } from "./DelegateCoordinator.ts";
import { ThreadBranchCoordinator, ThreadBranchCoordinatorLive } from "./ThreadBranchCoordinator.ts";
import { DelegateToolkit } from "./tools.ts";

const requireAgentsScope = Effect.fn("DelegateToolkit.requireAgentsScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("agents")) {
    return yield* new DelegateError({
      reason: "capability-unavailable",
      description: "This MCP credential does not grant the agents capability.",
    });
  }
  return invocation;
});

const requireThreadBranchScope = Effect.fn("DelegateToolkit.requireThreadBranchScope")(
  function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("agents")) {
      return yield* new BranchThreadError({
        reason: "capability-unavailable",
        description: "This MCP credential does not grant the agents capability.",
      });
    }
    return invocation;
  },
);

const DelegateToolkitHandlers = DelegateToolkit.toLayer({
  delegate_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* DelegateCoordinator;
      return yield* coordinator.delegate(scope, input);
    }),
  wait_for_delegate: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireAgentsScope();
      const coordinator = yield* DelegateCoordinator;
      return yield* coordinator.waitForDelegate(scope, input);
    }),
  branch_thread: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireThreadBranchScope();
      const coordinator = yield* ThreadBranchCoordinator;
      return yield* coordinator.branch(scope, input);
    }),
});

export const DelegateToolkitHandlersLive = DelegateToolkitHandlers.pipe(
  Layer.provide(Layer.mergeAll(DelegateCoordinatorLive, ThreadBranchCoordinatorLive)),
);
