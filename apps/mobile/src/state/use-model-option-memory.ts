import type { ProviderOptionSelection } from "@t3tools/contracts";
import { appAtomRegistry } from "./atom-registry";
import {
  modelOptionMemoryAtom,
  schedulePersistComposerState,
  type ModelOptionMemoryState,
} from "./use-composer-drafts";

/** Cross-thread memory of each model's last explicit option selection. */
function recordModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): ModelOptionMemoryState {
  if (options.length === 0) {
    return state;
  }
  return {
    ...state,
    [instanceId]: {
      ...(state[instanceId] ?? {}),
      [model]: options,
    },
  };
}

/** Pure lookup; `undefined` means "no memory, fall back to descriptor defaults". */
function lookupModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return state[instanceId]?.[model];
}

/** Records an explicitly chosen option set for one instance and model. */
export function rememberModelOptions(
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): void {
  if (options.length === 0) {
    return;
  }
  const current = appAtomRegistry.get(modelOptionMemoryAtom);
  const next = recordModelOptionsInState(current, String(instanceId), model, options);
  if (next !== current) {
    appAtomRegistry.set(modelOptionMemoryAtom, next);
    schedulePersistComposerState();
  }
}

export function rememberedModelOptions(
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return lookupModelOptionsInState(
    appAtomRegistry.get(modelOptionMemoryAtom),
    String(instanceId),
    model,
  );
}

/**
 * Restores a remembered option set for a freshly picked selection, keeping the
 * incoming selections when nothing is remembered or they already match.
 */
export function withRememberedModelOptions<
  T extends {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
>(selection: T): T {
  const remembered = rememberedModelOptions(selection.instanceId, selection.model);
  if (
    remembered === undefined ||
    JSON.stringify(remembered) === JSON.stringify(selection.options ?? [])
  ) {
    return selection;
  }
  return { ...selection, options: remembered };
}
