import {
  CommandId,
  type PiExternalCatalogSnapshot,
  type PiExternalCatalogStreamItem,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request, subscribe } from "../rpc/client.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface PiExternalCatalogState {
  readonly snapshot: PiExternalCatalogSnapshot | null;
  readonly synchronized: boolean;
}

export const EMPTY_PI_EXTERNAL_CATALOG_STATE: PiExternalCatalogState = {
  snapshot: null,
  synchronized: false,
};

export const PI_EXTERNAL_PROJECT_ID_PREFIX = "external:pi-project:";

export function isPiExternalProjectId(projectId: string): boolean {
  return projectId.startsWith(PI_EXTERNAL_PROJECT_ID_PREFIX);
}

export function reducePiExternalCatalog(
  state: PiExternalCatalogState,
  item: PiExternalCatalogStreamItem,
): PiExternalCatalogState {
  if (item.kind === "snapshot") {
    return {
      snapshot: item.snapshot,
      synchronized: false,
    };
  }
  return state.synchronized ? state : { ...state, synchronized: true };
}

function commandId(input?: CommandId) {
  if (input !== undefined) return Effect.succeed(input);
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.orDie,
    Effect.map(CommandId.make),
  );
}

export function createPiExternalThreadAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    catalog: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:pi-external:catalog",
      idleTtlMs: 0,
      subscribe: (_input: void) =>
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.switchMap(
                  Option.match({
                    onNone: () => Stream.make(EMPTY_PI_EXTERNAL_CATALOG_STATE),
                    onSome: (session) =>
                      Stream.unwrap(
                        session.initialConfig.pipe(
                          Effect.map((config) =>
                            (config.environment.capabilities.piExternalThreads === true
                              ? subscribe(
                                  WS_METHODS.piExternalSubscribeCatalog,
                                  { requestCompletionMarker: true },
                                  {
                                    onExpectedFailure: () => Effect.void,
                                    retryExpectedFailureAfter: "500 millis",
                                  },
                                )
                              : Stream.make({ kind: "synchronized" as const })
                            ).pipe(
                              Stream.scan(EMPTY_PI_EXTERNAL_CATALOG_STATE, reducePiExternalCatalog),
                            ),
                          ),
                        ),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ),
    }),
    createSession: createEnvironmentCommand(runtime, {
      label: "environment-data:pi-external:create-session",
      execute: (input: { readonly cwd: string; readonly commandId?: CommandId }) =>
        commandId(input.commandId).pipe(
          Effect.flatMap((stableCommandId) =>
            request(WS_METHODS.piExternalCreateSession, {
              commandId: stableCommandId,
              cwd: input.cwd,
            }),
          ),
        ),
    }),
  };
}
