import { type PluginNpmListResult, type PluginNpmPackage, WS_METHODS } from "@t3tools/contracts";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestIfSupported } from "../rpc/client.ts";
import { type PluginNpmStepMarker, supportsPluginNpm } from "./pluginNpmPresentation.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

type PluginNpmCommandTag =
  | typeof WS_METHODS.pluginsNpmAdd
  | typeof WS_METHODS.pluginsNpmStageUpdate
  | typeof WS_METHODS.pluginsNpmApplyUpdate
  | typeof WS_METHODS.pluginsNpmDiscardUpdate;

/** The npm packages behind an environment's plugins; fails unavailable on a server without them. */
export const listPluginNpmPackages = requestIfSupported(
  WS_METHODS.pluginsNpmList,
  {},
  supportsPluginNpm,
);

/**
 * Records a settled npm step against the list `registry` holds now, then reads
 * the list again. Refreshing interrupts a read already in flight, so only a
 * list read after the step can take the place of its reply.
 */
export function settlePluginNpmStep(
  registry: AtomRegistry.AtomRegistry,
  packages: Atom.Atom<AsyncResult.AsyncResult<PluginNpmListResult, unknown>>,
  reply: PluginNpmPackage | null,
): PluginNpmStepMarker {
  const current = registry.get(packages);
  registry.refresh(packages);
  return { list: current._tag === "Success" ? current.value : null, reply };
}

export function createPluginNpmEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One npm step per environment at a time, matching the server's own lock.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  /** A command that checks the capability on the session it would use, so an older server never receives it. */
  const command = <TTag extends PluginNpmCommandTag>(label: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label,
      tag,
      scheduler,
      concurrency,
      execute: (input) => requestIfSupported(tag, input, supportsPluginNpm),
    });
  return {
    /** Join to catalogue rows by `installationId`; read again after an npm step or a catalogue change. */
    packages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:npm:packages",
      tag: WS_METHODS.pluginsNpmList,
      execute: () => listPluginNpmPackages,
    }),
    add: command("environment-data:plugins:npm:add", WS_METHODS.pluginsNpmAdd),
    stageUpdate: command(
      "environment-data:plugins:npm:stage-update",
      WS_METHODS.pluginsNpmStageUpdate,
    ),
    applyUpdate: command(
      "environment-data:plugins:npm:apply-update",
      WS_METHODS.pluginsNpmApplyUpdate,
    ),
    discardUpdate: command(
      "environment-data:plugins:npm:discard-update",
      WS_METHODS.pluginsNpmDiscardUpdate,
    ),
  };
}
