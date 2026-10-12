import {
  type ExecutionEnvironmentCapabilities,
  type PluginAction,
  type PluginActionPlacement,
  type PluginActionsSnapshot,
  type PluginActionTarget,
  type ProjectId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { requestIfSupported, subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const supportsPluginActions = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pluginActions"> | null | undefined,
) => capabilities?.pluginActions === true;

const NO_ACTIONS: PluginActionsSnapshot = { actions: [] };

/**
 * The environment's plugin actions snapshot, following its sessions. A server
 * without the capability is never subscribed to and offers none. `omitted`
 * is kept so a surface can explain actions the server's limit left out.
 */
export const pluginActionsStream = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config) =>
                    supportsPluginActions(config.environment.capabilities)
                      ? subscribe(WS_METHODS.pluginActionsSubscribe, {})
                      : Stream.succeed(NO_ACTIONS),
                  ),
                  Effect.orElseSucceed(() => Stream.empty),
                ),
              ),
          }),
        ),
      ),
    ),
  ),
);

export function createPluginActionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Every action the environment offers now, plus `omitted` counts when its
     * limit left plugins out; no actions on servers without plugin actions.
     */
    snapshot: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugin-actions",
      subscribe: (_input: Record<string, never>) => pluginActionsStream,
    }),
    /** Runs on the session it checked, so an older server never receives it. */
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-actions:invoke",
      tag: WS_METHODS.pluginActionsInvoke,
      execute: (input) =>
        requestIfSupported(WS_METHODS.pluginActionsInvoke, input, supportsPluginActions),
    }),
  };
}

/** What a surface knows about where the user is. */
export interface PluginActionContext {
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}

/** The target `action` runs on from `context`, or null when the surface cannot supply it. */
function pluginActionTarget(
  action: Pick<PluginAction, "target">,
  context: PluginActionContext,
): PluginActionTarget | null {
  switch (action.target) {
    case "environment":
      return { _tag: "environment" };
    case "project":
      return context.projectId === null ? null : { _tag: "project", projectId: context.projectId };
    case "thread":
      return context.threadId === null ? null : { _tag: "thread", threadId: context.threadId };
  }
}

/** The actions a surface offers at `placement`, each with the target it would run on. */
export function pluginActionsAt(
  actions: ReadonlyArray<PluginAction>,
  placement: PluginActionPlacement,
  context: PluginActionContext,
): ReadonlyArray<{ readonly action: PluginAction; readonly target: PluginActionTarget }> {
  return actions.flatMap((action) => {
    if (!action.placements.includes(placement)) return [];
    const target = pluginActionTarget(action, context);
    return target === null ? [] : [{ action, target }];
  });
}

/** Menu labels that stay distinct when two plugins use the same title. */
export function pluginActionLabels(actions: ReadonlyArray<PluginAction>): ReadonlyArray<string> {
  const titleCounts = new Map<string, number>();
  for (const action of actions) {
    titleCounts.set(action.title, (titleCounts.get(action.title) ?? 0) + 1);
  }
  return actions.map((action) =>
    (titleCounts.get(action.title) ?? 0) > 1
      ? `${action.title} (${action.pluginName})`
      : action.title,
  );
}
