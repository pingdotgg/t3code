import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Dictation atoms for every environment. Install and remove run one at a time
 * per environment; session commands run in parallel because the server orders
 * appended chunks by `seq`.
 */
export function createDictationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Server-pushed engine settings, install progress, and readiness for one environment. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:dictation:state",
      tag: WS_METHODS.subscribeDictationState,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:install",
      tag: WS_METHODS.dictationInstall,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:remove",
      tag: WS_METHODS.dictationRemove,
      scheduler,
      concurrency,
    }),
    /** Opens a session and starts loading the model, so warm-up overlaps speaking. */
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:start",
      tag: WS_METHODS.dictationStart,
    }),
    /** Loads the speech model ahead of a likely dictation, e.g. on composer focus. */
    warm: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:warm",
      tag: WS_METHODS.dictationWarm,
    }),
    append: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:append",
      tag: WS_METHODS.dictationAppend,
    }),
    finish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:finish",
      tag: WS_METHODS.dictationFinish,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:dictation:cancel",
      tag: WS_METHODS.dictationCancel,
    }),
  };
}

/**
 * Picks the environment that transcribes this device's dictation. `ready`
 * lists connected environments whose dictation is ready, in display order.
 * A chosen environment wins while it is ready; otherwise the environment that
 * owns the draft, then the primary, then any ready environment.
 */
export function resolveDictationEnvironment(input: {
  readonly chosen: EnvironmentId | null;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly ready: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  const candidates = [input.chosen, input.draftEnvironmentId, input.primaryEnvironmentId];
  return (
    candidates.find(
      (environmentId) => environmentId !== null && input.ready.includes(environmentId),
    ) ??
    input.ready[0] ??
    null
  );
}
