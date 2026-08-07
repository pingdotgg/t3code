/**
 * Provider skill inventory selection, shared by web and mobile.
 *
 * A provider that advertises `skillInventoryMode: "project"` computes its
 * skills from the directory the agent will run in, so client surfaces ask the
 * environment server instead of reading `ServerProvider.skills`. Everyone else
 * keeps the snapshot array and issues no request at all.
 *
 * Only the decisions live here — whether to ask, what to ask for, and which
 * rows to render. Each client keeps its own `useEnvironmentQuery` binding.
 *
 * @module state/providerSkillInventory
 */
import {
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSkillInventoryInput,
  type ServerProviderSkillInventoryResult,
  type ServerProviderSkillInventoryScope,
  type ThreadId,
  usesProjectSkillInventory,
} from "@t3tools/contracts";

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

export interface ProviderSkillInventoryTarget {
  readonly environmentId: EnvironmentId | null;
  /** The provider snapshot backing the current model selection. */
  readonly provider: ServerProvider | null;
  /** The thread or project whose working directory the provider will use. */
  readonly scope: ServerProviderSkillInventoryScope | null;
}

/**
 * Surface context from which the shared client derives one inventory target.
 * Local drafts can already have a thread id, so `isServerThread` is the
 * authority for choosing thread scope instead of treating any id as durable.
 */
export interface ProviderSkillInventoryContext {
  readonly activeEnvironmentId: EnvironmentId | null | undefined;
  readonly fallbackEnvironmentId?: EnvironmentId | null;
  readonly provider: ServerProvider | null;
  readonly isServerThread: boolean;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}

export interface ProviderSkillInventoryRequest {
  readonly environmentId: EnvironmentId;
  readonly input: ServerProviderSkillInventoryInput;
}

/** Resolve surface state into the single target shape used by web and mobile. */
export function resolveProviderSkillInventoryTarget(
  context: ProviderSkillInventoryContext,
): ProviderSkillInventoryTarget {
  return {
    environmentId: context.activeEnvironmentId ?? context.fallbackEnvironmentId ?? null,
    provider: context.provider,
    scope:
      context.isServerThread && context.threadId !== null
        ? { kind: "thread", threadId: context.threadId }
        : context.projectId !== null
          ? { kind: "project", projectId: context.projectId }
          : null,
  };
}

/**
 * The request backing a project-scoped provider, or `null` when no request
 * should be made because the provider uses snapshot skills or the scope cannot
 * be identified.
 *
 * The result is a stable inventory key: it changes with the environment, the
 * scope, and the provider instance, and with nothing else. In particular the
 * user's query text is absent, so typing filters locally instead of refetching.
 */
export function resolveProviderSkillInventoryRequest(
  target: ProviderSkillInventoryTarget,
): ProviderSkillInventoryRequest | null {
  if (target.environmentId === null || target.provider === null || target.scope === null) {
    return null;
  }
  if (!usesProjectSkillInventory(target.provider)) {
    return null;
  }

  const instanceId: ProviderInstanceId = target.provider.instanceId;
  return { environmentId: target.environmentId, input: { scope: target.scope, instanceId } };
}

/**
 * The rows a picker, composer, or message surface should render.
 *
 * Snapshot-mode providers always use their snapshot skills. A project-mode
 * provider uses its last successful inventory, which the query layer keeps
 * available while a refresh is in flight; before the first response and after
 * a failure it falls back to the snapshot array, so a broken RPC degrades to
 * today's behavior rather than an empty menu.
 */
export function selectProviderSkills(input: {
  readonly provider: ServerProvider | null;
  readonly inventory: ServerProviderSkillInventoryResult | null;
}): ReadonlyArray<ServerProviderSkill> {
  if (input.provider === null) {
    return NO_SKILLS;
  }
  if (usesProjectSkillInventory(input.provider) && input.inventory !== null) {
    return input.inventory.skills;
  }
  return input.provider.skills;
}
