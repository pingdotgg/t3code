import { useAtomValue } from "@effect/atom-react";
import {
  createDictationEnvironmentAtoms,
  resolveDictationEnvironment,
} from "@t3tools/client-runtime/state/dictation";
import type { ClientSettings, DictationState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { usePrimaryEnvironmentId } from "./environments";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";

export const dictationEnvironment = createDictationEnvironmentAtoms(connectionAtomRuntime);

/**
 * The latest dictation state for one environment. While the subscription
 * reconnects it keeps the last state it saw, so settings rows do not blank out.
 */
const lastDictationStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): DictationState | null => {
    const current = AsyncResult.value(
      get(dictationEnvironment.state({ environmentId, input: {} })),
    );
    return Option.isSome(current)
      ? current.value
      : Option.getOrNull(get.self<DictationState | null>());
  }).pipe(Atom.withLabel(`dictation:last-state:${environmentId}`)),
);

const NO_DICTATION_STATE = Atom.make<DictationState | null>(null);

/** Dictation state for one environment; null until it first loads or when the server lacks dictation. */
export function useDictationState(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : dictationEnvironment.state({ environmentId, input: {} }),
  );
  const state = useAtomValue(
    environmentId === null ? NO_DICTATION_STATE : lastDictationStateAtom(environmentId),
  );
  return { state, error: query.error };
}

/**
 * Connected environments that can transcribe right now, in display order.
 * Keeps the previous array while membership is unchanged, so install progress
 * on one environment does not re-render every composer.
 */
const readyDictationEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      Option.getOrNull(
        AsyncResult.value(get(dictationEnvironment.state({ environmentId, input: {} }))),
      )?.ready === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((environmentId, index) => environmentId === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("dictation:ready-environment-ids"));

export function useReadyDictationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(readyDictationEnvironmentIdsAtom);
}

const selectDictationEnvironmentId = (settings: ClientSettings) => settings.dictationEnvironmentId;

/** The environment this device dictates through for a draft, or null when none is ready. */
export function useDictationEnvironmentId(
  draftEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  return resolveDictationEnvironment({
    chosen: useClientSettings(selectDictationEnvironmentId),
    draftEnvironmentId,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    ready: useReadyDictationEnvironmentIds(),
  });
}
