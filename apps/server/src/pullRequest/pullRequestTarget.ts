import type {
  OrchestrationProjectShell,
  RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";

export interface PullRequestTarget {
  readonly url?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
  readonly host?: string | undefined;
}

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

export type PullRequestTargetError =
  | PullRequestUrlInvalidError
  | PullRequestTargetIncompleteError
  | PullRequestHostRequiredError
  | PullRequestUrlUnavailableError;

export interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * The repository whose host and provider supply defaults for a repository-and-number input: the
 * project's own, or for a workspace folder, the checkout of that repository on the given host.
 * A repository the folder doesn't hold takes the host its checkouts share, and none when they
 * are on several, so the agent is asked for one rather than given a guess.
 */
function projectRepositoryFor(
  project: OrchestrationProjectShell | undefined,
  repository: string,
  host: string | undefined,
): RepositoryIdentity | null {
  if (project?.repositoryIdentity != null) return project.repositoryIdentity;
  const checkouts = (project?.workspaceRepositories ?? []).filter(
    (identity) => host === undefined || projectHostAndProvider(identity).host === host,
  );
  const held = checkouts.find((identity) => namesRepository(identity, repository));
  if (held !== undefined) return held;
  const hosts = new Set(checkouts.map((identity) => projectHostAndProvider(identity).host));
  return hosts.size === 1 ? (checkouts[0] ?? null) : null;
}

function namesRepository(identity: RepositoryIdentity, repository: string): boolean {
  const wanted = repository.toLowerCase();
  return [
    sourceControlDefinitions.repositorySelector(identity),
    identity.displayName,
    // The path below the host, which is how Azure names a repository in full.
    identity.canonicalKey.split("/").slice(1).join("/"),
  ].some((name) => name?.toLowerCase() === wanted);
}

/**
 * A workspace folder's checkout of `repository`, or without one, its only repository. Undefined
 * for a project rooted in a repository, and for a name the folder doesn't hold.
 */
export function workspaceCheckout(
  project: OrchestrationProjectShell,
  repository: string | undefined,
): RepositoryIdentity | undefined {
  if (project.repositoryIdentity != null) return undefined;
  const checkouts = project.workspaceRepositories ?? [];
  if (repository !== undefined) {
    return checkouts.find((identity) => namesRepository(identity, repository));
  }
  const repositories = new Set(checkouts.map((identity) => identity.canonicalKey));
  return repositories.size === 1 ? checkouts[0] : undefined;
}

function projectHostAndProvider(identity: RepositoryIdentity | null): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

export const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTarget,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    if (parsed === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return {
      ...normalizeThreadPullRequestKey(parsed),
      url: canonicalizeGitCafePullRequestUrl(input.url),
    } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const identity = projectRepositoryFor(project, input.repository, input.host?.toLowerCase());
  const projectHost = projectHostAndProvider(identity);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const recognizedKind = sourceControlDefinitions.recognizeRemote(`https://${host}`)?.kind;
  const kind =
    sourceControlDefinitions.findByPublicHost(host)?.kind ??
    (recognizedKind === "gitcafe" ? recognizedKind : projectHost.kind);
  const url =
    kind === null
      ? null
      : sourceControlDefinitions.get(kind).changeRequestUrl({
          host,
          repository,
          number: input.number,
          remoteUrl: identity?.locator.remoteUrl,
        });
  if (url === null) {
    return yield* new PullRequestUrlUnavailableError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url: canonicalizeGitCafePullRequestUrl(url),
  } satisfies ResolvedTarget;
});
