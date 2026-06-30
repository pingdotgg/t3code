import {
  DEFAULT_MODEL_BY_PROVIDER,
  type AgentSelection,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useComposerDraftStore } from "../composerDraftStore";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerConfigAtom } from "../state/server";
import { environmentThreadShells } from "../state/threads";

type AgentChoice = AgentSelection | null;

export interface RecentAgentSources {
  readonly sticky: AgentChoice;
  readonly recentThread: AgentChoice;
  readonly defaultChoice: AgentChoice;
  readonly isAvailable: (instance: string) => boolean;
}

export function pickRecentAgent(sources: RecentAgentSources): AgentSelection | null {
  for (const candidate of [sources.sticky, sources.recentThread, sources.defaultChoice]) {
    if (candidate && sources.isAvailable(candidate.instance)) {
      return candidate;
    }
  }
  return null;
}

const fromModelSelection = (selection: ModelSelection | null | undefined): AgentChoice =>
  selection
    ? {
        instance: selection.instanceId,
        model: selection.model,
      }
    : null;

function resolveStickyAgent(): AgentChoice {
  const composerState = useComposerDraftStore.getState();
  const activeProvider = composerState.stickyActiveProvider;
  return activeProvider
    ? fromModelSelection(composerState.stickyModelSelectionByProvider[activeProvider])
    : null;
}

function resolveRecentThreadAgent(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): AgentChoice {
  const [latestShell] = [...shells].sort(
    (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
      right.updatedAt.localeCompare(left.updatedAt),
  );
  return fromModelSelection(latestShell?.modelSelection);
}

function resolveDefaultAgent(input: {
  readonly entries: ReturnType<typeof deriveProviderInstanceEntries>;
}): AgentChoice {
  const entry = input.entries[0];
  if (!entry) {
    return null;
  }
  const model =
    entry.models.find((candidate) => !candidate.isCustom)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind];
  if (!model) {
    return null;
  }
  return {
    instance: entry.instanceId,
    model,
  };
}

export function resolveRecentAgent(
  providers?: ReadonlyArray<ServerProvider>,
  shells?: ReadonlyArray<EnvironmentThreadShell>,
): AgentSelection | null {
  const availableEntries = deriveProviderInstanceEntries(
    providers ?? appAtomRegistry.get(primaryServerConfigAtom)?.providers ?? [],
  ).filter((entry) => entry.enabled && entry.installed && entry.isAvailable);
  const availableInstances = new Set<ProviderInstanceId>(
    availableEntries.map((entry) => entry.instanceId),
  );

  const threadShells = shells ?? appAtomRegistry.get(environmentThreadShells.threadShellsAtom);

  return pickRecentAgent({
    sticky: resolveStickyAgent(),
    recentThread: resolveRecentThreadAgent(threadShells),
    defaultChoice: resolveDefaultAgent({ entries: availableEntries }),
    isAvailable: (instance) => availableInstances.has(instance as ProviderInstanceId),
  });
}
