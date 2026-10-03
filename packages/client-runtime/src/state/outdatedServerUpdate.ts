import type { EnvironmentId, ServerSelfUpdateInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { Atom } from "effect/unstable/reactivity";
import type * as Socket from "effect/unstable/socket/Socket";

import { updateOutdatedHost } from "../connection/outdatedHostUpdate.ts";
import type * as ConnectionResolver from "../connection/resolver.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import { createAtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";
import {
  serverUpdateFailureMessage,
  serverUpdateStateAtom,
  type ServerUpdateStage,
} from "./server.ts";

export interface OutdatedServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ServerSelfUpdateInput;
  /** From the host descriptor when known; an outdated host never delivers a server config. */
  readonly fromVersion?: string;
}

/**
 * Updates a host too old for this client to connect to. Progress lands in the
 * same per-environment update state as a normal server update.
 */
export function createOutdatedServerUpdateCommand<E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | ConnectionResolver.ConnectionResolver
    | RelayEnvironmentDiscovery.RelayEnvironmentDiscovery
    | Socket.WebSocketConstructor
    | HttpClient.HttpClient,
    E
  >,
) {
  return createRuntimeCommand(runtime, {
    label: "environment-data:server:update-outdated-server",
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }: OutdatedServerUpdateTarget) => environmentId,
    },
    execute: (target: OutdatedServerUpdateTarget, atomRegistry) => {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      const targetVersion = target.input.targetVersion;
      const fromVersion = target.fromVersion ?? targetVersion;
      let currentStage: ServerUpdateStage = "downloading";
      const setStage = (stage: ServerUpdateStage) =>
        Effect.sync(() => {
          currentStage = stage;
          atomRegistry.set(stateAtom, { status: "running", stage, fromVersion, targetVersion });
        });
      return setStage(currentStage).pipe(
        Effect.andThen(updateOutdatedHost(target.environmentId, target.input, setStage)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, { status: "idle" });
              return;
            }
            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    },
  });
}
