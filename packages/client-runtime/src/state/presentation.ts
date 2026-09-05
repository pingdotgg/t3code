import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  presentEnvironmentConnection,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/** Stable identity of environments still connecting or waiting for their first config snapshot. */
export function environmentPresentationSettlingKey(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): string | null {
  const environmentIds: EnvironmentId[] = [];
  for (const [environmentId, { connection, serverConfig }] of presentations) {
    if (
      connection.phase === "connecting" ||
      connection.phase === "reconnecting" ||
      (connection.phase === "connected" && serverConfig === null)
    ) {
      environmentIds.push(environmentId);
    }
  }
  // Hermes does not provide ES2023 `toSorted`; this local array is safe to sort in place.
  return environmentIds.length > 0 ? JSON.stringify(environmentIds.sort()) : null;
}

export function createEnvironmentPresentationAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
  /** Authoritative live server config, including streamed provider/settings updates. */
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const presentationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      if (entry === undefined) {
        return null;
      }
      const state = Option.getOrElse(
        AsyncResult.value(get(input.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      return {
        entry,
        connection: presentEnvironmentConnection(state),
        serverConfig: get(input.serverConfigValueAtom(environmentId)),
      } satisfies EnvironmentPresentation;
    }).pipe(Atom.withLabel(`environment-presentation:${environmentId}`)),
  );

  let previous: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentPresentation>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const presentation = get(presentationAtom(environmentId));
      if (presentation !== null) {
        next.set(environmentId, presentation);
      }
    }
    if (mapsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  return {
    presentationAtom,
    presentationsAtom,
  };
}
