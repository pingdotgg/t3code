import type { ProviderOptionSelection } from "@t3tools/contracts";
import { withoutUltracode } from "@t3tools/shared/model";
import { appAtomRegistry } from "./atom-registry";
import {
  modelOptionMemoryAtom,
  schedulePersistComposerState,
  type ModelOptionMemoryState,
} from "./use-composer-drafts";

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
      ...state[instanceId],
      [model]: options,
    },
  };
}

function lookupModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return state[instanceId]?.[model];
}

export function rememberModelOptions(
  instanceId: string,
  model: string,
  selections: ReadonlyArray<ProviderOptionSelection>,
): void {
  const options = withoutUltracode(selections);
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

function rememberedModelOptions(
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return lookupModelOptionsInState(
    appAtomRegistry.get(modelOptionMemoryAtom),
    String(instanceId),
    model,
  );
}

export function withRememberedModelOptions<
  T extends {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
>(selection: T): T {
  const stored = rememberedModelOptions(selection.instanceId, selection.model);
  if (stored === undefined) {
    return selection;
  }
  // Memory never holds Ultracode, so a selection keeps its own.
  const remembered = [
    ...stored,
    ...(selection.options ?? []).filter(
      (option) => option.id === "ultracode" && option.value === true,
    ),
  ];
  if (JSON.stringify(remembered) === JSON.stringify(selection.options ?? [])) {
    return selection;
  }
  return { ...selection, options: remembered };
}
