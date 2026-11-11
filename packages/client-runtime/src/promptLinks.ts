import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ModelSelection,
  type PullRequestLinkedThreadsResult,
  type RepositoryIdentity,
  type ServerProvider,
  type ThreadLinkedPullRequest,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveSelectableModel, type SelectableModelOption } from "@t3tools/shared/model";
import type { AsyncResult } from "effect/reactivity";
import type { PromptLinkPullRequest, PromptLinkRepository } from "@t3tools/shared/promptLinks";
import {
  threadPullRequestKeyOf,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "./threadPullRequests.ts";

// A link's `owner/name` is GitHub's. GitCafe syncs a repository two-way with GitHub under the
// same path, so a checkout cloned from git.cafe counts as the linked repository.
const PROMPT_LINK_REPOSITORY_HOSTS = ["github.com", "git.cafe", "staging.git.cafe"];

/**
 * The repository's projects in the order given. Callers pass projects most recently active
 * first and open the first, so the user lands where they last worked.
 */
export function findPromptLinkProjects<
  P extends { readonly repositoryIdentity?: RepositoryIdentity | null | undefined },
>(projects: ReadonlyArray<P>, repository: PromptLinkRepository): P[] {
  const path = `${repository.owner}/${repository.name}`.toLowerCase();
  const keys = new Set(PROMPT_LINK_REPOSITORY_HOSTS.map((host) => `${host}/${path}`));
  return projects.filter(
    (project) =>
      project.repositoryIdentity != null &&
      keys.has(repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()),
  );
}

export function findPromptLinkPullRequestThread<
  T extends {
    readonly updatedAt: string;
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
    readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    readonly lineage?: { readonly sideChat?: boolean | undefined } | undefined;
  },
>(threads: ReadonlyArray<T>, pullRequest: PromptLinkPullRequest): T | undefined {
  const key = threadPullRequestKeyOf({
    host: "github.com",
    repository: `${pullRequest.owner}/${pullRequest.name}`,
    number: pullRequest.number,
  });
  let latest: T | undefined;
  for (const thread of threads) {
    if (latest !== undefined && thread.updatedAt <= latest.updatedAt) continue;
    // Side chats inherit their parent's links but stay hidden.
    if (thread.lineage?.sideChat === true) continue;
    const linked = visibleThreadPullRequests(threadPullRequestsOf(thread)).some(
      (link) => threadPullRequestKeyOf(link) === key,
    );
    if (linked) latest = thread;
  }
  return latest;
}

/**
 * The first open thread from per-environment pull request lookups, in the order given, once
 * every lookup before it has answered. `null` when none has one; `undefined` until then.
 */
export function pickPromptLinkPullRequestThread(
  lookups: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly result: AsyncResult.AsyncResult<PullRequestLinkedThreadsResult, unknown>;
  }>,
): { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined {
  for (const { environmentId, result } of lookups) {
    if (result._tag === "Initial" || result.waiting) return undefined;
    const thread =
      result._tag === "Success"
        ? result.value.threads.find((candidate) => candidate.archivedAt === null)
        : undefined;
    if (thread !== undefined) return { environmentId, id: thread.id };
  }
  return null;
}

const PROVIDER_ALIASES: Record<string, string> = { claude: "claudeagent" };

/**
 * `exact` is false when the instance exists but the model does not, so its default model
 * stands in. Null when no usable instance of that provider exists; the user's default
 * applies then.
 */
export function resolvePromptLinkModelSelection(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "availability" | "status"> & {
      readonly models: ReadonlyArray<
        SelectableModelOption & { readonly isDefault?: boolean | undefined }
      >;
    }
  >,
  request: { readonly provider: string; readonly model: string | null },
): { readonly selection: ModelSelection; readonly exact: boolean } | null {
  const driver = PROVIDER_ALIASES[request.provider] ?? request.provider;
  const usable = providers.filter(
    (provider) =>
      provider.driver.toLowerCase() === driver &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
  const instance =
    usable.find((provider) => provider.status === "ready") ??
    usable.find((provider) => provider.status === "warning");
  if (instance === undefined) return null;
  const requested =
    request.model === null
      ? null
      : resolveSelectableModel(instance.driver, request.model, instance.models);
  const model =
    requested ??
    (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug;
  if (model === undefined) return null;
  return {
    selection: { instanceId: instance.instanceId, model },
    exact: request.model === null || requested !== null,
  };
}
