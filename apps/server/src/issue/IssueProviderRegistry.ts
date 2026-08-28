import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  issueRepositoryKey,
  type IssueListInput,
  type IssueProviderKind,
  type OrchestrationProjectShell,
  type SourceControlProviderInfo,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";
import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import * as BitbucketIssueProvider from "./BitbucketIssueProvider.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import * as GitLabIssueProvider from "./GitLabIssueProvider.ts";
import * as LinearIssueProvider from "./LinearIssueProvider.ts";
import {
  issueProviderContextKey,
  type IssueAdapter,
  type IssueAdapterSource,
} from "./IssueProvider.ts";

const SOURCE_RESOLUTION_CONCURRENCY = 12;

export interface IssueProjectSource {
  readonly project: OrchestrationProjectShell;
  readonly adapter: IssueAdapter;
  readonly repository: string;
  readonly host: string;
  readonly credentialId?: string;
}

export interface IssueWorkspaceProjects {
  readonly supported: ReadonlyArray<IssueProjectSource>;
  readonly unimplemented: ReadonlyMap<
    string,
    {
      readonly host: string;
      readonly kind: IssueProviderKind;
      readonly projectCount: number;
    }
  >;
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

type IssueProjectFilter = Pick<IssueListInput, "projectId" | "host">;

type BoundIssueSource = IssueAdapterSource & { readonly adapter: IssueAdapter };

type ResolvedProjectSource = IssueAdapterSource & {
  readonly adapter: IssueAdapter | null;
  readonly kind: IssueProviderKind;
};

function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

function issueHostOf(
  identity: OrchestrationProjectShell["repositoryIdentity"],
  kind: IssueProviderKind,
): string {
  const canonicalHost = identity?.canonicalKey?.split("/")[0]?.trim();
  if (canonicalHost !== undefined && canonicalHost.length > 0) return canonicalHost.toLowerCase();
  const provider = identity
    ? detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)
    : null;
  return provider === null ? kind : new URL(provider.baseUrl).host.toLowerCase();
}

function adapterSourcesOf(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  filter: IssueProjectFilter,
  adapters: ReadonlyMap<IssueProviderKind, IssueAdapter>,
): Effect.Effect<ReadonlyMap<OrchestrationProjectShell["id"], ReadonlyArray<BoundIssueSource>>> {
  return Effect.gen(function* () {
    const sources = new Map<OrchestrationProjectShell["id"], BoundIssueSource[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      for (const adapter of adapters.values()) {
        const source =
          adapter.resolveSource === undefined ? null : yield* adapter.resolveSource(project);
        if (source === undefined || source === null) continue;
        const bound = { adapter, ...source };
        const projectSources = sources.get(project.id);
        if (projectSources === undefined) sources.set(project.id, [bound]);
        else projectSources.push(bound);
      }
    }
    return sources;
  });
}

function resolveProjectSource(
  project: OrchestrationProjectShell,
  refinedKinds: ReadonlyMap<string, IssueProviderKind>,
  adapters: ReadonlyMap<IssueProviderKind, IssueAdapter>,
): ResolvedProjectSource | null {
  const identity = project.repositoryIdentity;
  let kind = identity?.provider;
  const repository = repositoryIdentityOf(project);
  if (!identity || kind === undefined || repository === null) return null;
  if (kind === "unknown") {
    const provider = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
    kind = provider === null ? kind : (refinedKinds.get(provider.baseUrl) ?? kind);
  }
  return {
    adapter: adapters.get(kind) ?? null,
    kind,
    repository,
    host: issueHostOf(identity, kind),
  };
}

function projectResolver(
  byKind: ReadonlyMap<IssueProviderKind, IssueAdapter>,
  sourceControlProviders?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
) {
  const refineUnknownKinds = Effect.fn("IssueProviderRegistry.refineUnknownKinds")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: IssueProjectFilter,
  ) {
    if (sourceControlProviders === undefined) return new Map<string, IssueProviderKind>();

    type Candidate = {
      readonly project: OrchestrationProjectShell;
      readonly provider: SourceControlProviderInfo;
      readonly remoteName: string;
      readonly remoteUrl: string;
    };
    const refinements = new Map<string, Candidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (identity?.provider !== "unknown" || repositoryIdentityOf(project) === null) continue;
      const host = issueHostOf(identity, "unknown");
      if (filter.host !== undefined && host !== "unknown" && host !== filter.host.toLowerCase()) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
      if (provider === null) continue;
      const candidate = { project, provider, remoteName, remoteUrl };
      const candidates = refinements.get(provider.baseUrl);
      if (candidates === undefined) refinements.set(provider.baseUrl, [candidate]);
      else candidates.push(candidate);
    }

    const resolved = yield* Effect.forEach(
      refinements,
      ([baseUrl, candidates]) =>
        Effect.firstSuccessOf(
          candidates.map(({ project, provider, remoteName, remoteUrl }) =>
            Effect.suspend(() =>
              sourceControlProviders.resolveHandle({
                cwd: project.workspaceRoot,
                context: { provider, remoteName, remoteUrl },
              }),
            ).pipe(
              Effect.flatMap((handle) => {
                const kind = handle.context?.provider.kind;
                return kind === undefined || kind === "unknown"
                  ? Effect.fail(undefined)
                  : Effect.succeed(kind);
              }),
            ),
          ),
        ).pipe(
          Effect.map((kind) => [baseUrl, kind] as const),
          Effect.orElseSucceed(() => [baseUrl, "unknown"] as const),
        ),
      { concurrency: SOURCE_RESOLUTION_CONCURRENCY },
    );
    return new Map(resolved);
  });

  return Effect.fn("IssueProviderRegistry.resolveProjects")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: IssueProjectFilter,
  ) {
    const boundSources = yield* adapterSourcesOf(projects, filter, byKind);
    const refinedKinds = yield* refineUnknownKinds(projects, filter);
    const supported: IssueProjectSource[] = [];
    const unimplemented = new Map<
      string,
      {
        host: string;
        kind: IssueProviderKind;
        projectCount: number;
      }
    >();
    const viewerRoots = new Map<string, string[]>();
    const seen = new Set<string>();

    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const sources: ResolvedProjectSource[] = [];
      for (const bound of boundSources.get(project.id) ?? []) {
        const repository = bound.repository.trim();
        const host = bound.host.trim().toLowerCase();
        if (repository.length > 0 && host.length > 0) {
          sources.push({
            adapter: bound.adapter,
            kind: bound.adapter.kind,
            repository,
            host,
            ...(bound.credentialId === undefined ? {} : { credentialId: bound.credentialId }),
          });
        }
      }
      const sourceControl = resolveProjectSource(project, refinedKinds, byKind);
      if (sourceControl !== null) sources.push(sourceControl);

      for (const { adapter, kind, repository, host, credentialId } of sources) {
        if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
        const sourceKey = issueProviderContextKey(kind, host, credentialId);
        if (adapter !== null) {
          const roots = viewerRoots.get(sourceKey);
          if (roots === undefined) viewerRoots.set(sourceKey, [project.workspaceRoot]);
          else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
        }
        const key = `${issueRepositoryKey(kind, host, repository)}\n${credentialId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (adapter === null) {
          const counted = unimplemented.get(sourceKey);
          if (counted === undefined) {
            unimplemented.set(sourceKey, { host, kind, projectCount: 1 });
          } else counted.projectCount += 1;
          continue;
        }
        supported.push({
          project,
          adapter,
          repository,
          host,
          ...(credentialId === undefined ? {} : { credentialId }),
        });
      }
    }

    return { supported, unimplemented, viewerRoots };
  });
}

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    readonly resolveProjects: (
      projects: ReadonlyArray<OrchestrationProjectShell>,
      filter: IssueProjectFilter,
    ) => Effect.Effect<IssueWorkspaceProjects>;
  }
>()("t3/issue/IssueProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export function fromProviders(
  providers: ReadonlyArray<IssueAdapter>,
  sourceControlProviders?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
): IssueProviderRegistry["Service"] {
  const byKind = new Map<IssueProviderKind, IssueAdapter>(
    providers.map((provider) => [provider.kind, provider]),
  );
  return {
    resolveProjects: projectResolver(byKind, sourceControlProviders),
  };
}

/**
 * The hosts this build can read issues from. A host with no entry here still shows up in the
 * provider list as unimplemented, so its projects are explained rather than missing.
 */
export const make = Effect.gen(function* () {
  const providers = yield* Effect.all([
    GitHubIssueProvider.make,
    GitLabIssueProvider.make,
    BitbucketIssueProvider.make,
    AzureDevOpsIssueProvider.make,
    LinearIssueProvider.make,
  ]);
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return fromProviders(providers, sourceControlProviders);
});

export const layer = Layer.effect(IssueProviderRegistry, make).pipe(
  Layer.provide(GitHubIssueCli.layer.pipe(Layer.provide(GitHubCli.layer))),
  Layer.provide(GitLabIssueCli.layer.pipe(Layer.provide(GitLabCli.layer))),
  Layer.provide(BitbucketIssueApi.layer.pipe(Layer.provide(BitbucketApi.layer))),
  Layer.provide(AzureDevOpsIssueCli.layer.pipe(Layer.provide(AzureDevOpsCli.layer))),
);
