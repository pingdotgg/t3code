import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  type ProjectId,
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import { providerContextFromOverride } from "./RemoteOverride.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { type SourceControlProviderDiscoverySpec } from "./SourceControlProviderDiscovery.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);
const PROVIDER_DETECTION_CACHE_KEY_SEPARATOR = "\u0000";

interface SourceControlProviderResolveInput {
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
}

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
  readonly contextSource: "override" | "detected" | null;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (
      input: SourceControlProviderResolveInput,
    ) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (
      input: SourceControlProviderResolveInput,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  }
>()("t3/sourceControl/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider["Service"] {
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "listChangeRequests",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getDefaultBranch",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "checkoutChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  });
}

function providerDetectionCacheKey(input: SourceControlProviderResolveInput) {
  return `${input.cwd}${PROVIDER_DETECTION_CACHE_KEY_SEPARATOR}${input.projectId ?? ""}`;
}

function providerDetectionInputFromCacheKey(key: string): SourceControlProviderResolveInput {
  const separatorIndex = key.lastIndexOf(PROVIDER_DETECTION_CACHE_KEY_SEPARATOR);
  const cwd = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
  const projectId = separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
  return projectId ? { cwd, projectId: projectId as ProjectId } : { cwd };
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = [];
  for (const remote of remotes) {
    const provider = detectSourceControlProviderFromRemoteUrl(remote.url);
    if (provider) {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    }
  }

  const hasKnownProvider = (candidate: SourceControlProvider.SourceControlProviderContext) =>
    candidate.provider.kind !== "unknown";
  return (
    candidates.find(
      (candidate) => candidate.remoteName === "origin" && hasKnownProvider(candidate),
    ) ??
    candidates.find(hasKnownProvider) ??
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates[0] ??
    null
  );
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider["Service"] {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
  });
}

export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cacheKey: string) {
        const input = providerDetectionInputFromCacheKey(cacheKey);
        const { cwd, projectId } = input;

        // A settings read failure falls back to remote-based detection instead
        // of failing every source-control operation; the warning keeps the
        // skipped override visible, and the cache is invalidated on the next
        // settings change.
        const projectOverride = (overrideProjectId: ProjectId) =>
          serverSettings.getProjectSettings(overrideProjectId).pipe(
            Effect.map((settings) => settings.remoteOverride ?? null),
            Effect.tapError((error) =>
              Effect.logWarning("project remote override lookup skipped: settings unavailable", {
                projectId: overrideProjectId,
                cause: error,
              }),
            ),
            Effect.orElseSucceed(() => null),
          );

        if (projectId) {
          const override = yield* projectOverride(projectId);
          const overrideContext = override ? providerContextFromOverride(override) : null;
          if (overrideContext) {
            return { context: overrideContext, source: "override" as const };
          }
        }

        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const repository = yield* handle.driver
          .detectRepository(cwd)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const projectOption = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(cwd)
          .pipe(
            Effect.flatMap((project) =>
              Option.isSome(project) || repository === null
                ? Effect.succeed(project)
                : projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(repository.rootPath),
            ),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
        if (!projectId && Option.isSome(projectOption)) {
          const override = yield* projectOverride(projectOption.value.id);
          const overrideContext = override ? providerContextFromOverride(override) : null;
          if (overrideContext) {
            return { context: overrideContext, source: "override" as const };
          }
        }

        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const context = selectProviderContext(remotes.remotes);

        const refinedContext = yield* SourceControlProviderDiscovery.refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd,
          context,
        });
        return { context: refinedContext, source: refinedContext ? ("detected" as const) : null };
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      {
        readonly context: SourceControlProvider.SourceControlProviderContext | null;
        readonly source: "override" | "detected" | null;
      },
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    // Saving a project's remote override must take effect immediately, not
    // after the detection cache TTL expires.
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, () =>
        Cache.invalidateAll(providerContextCache),
      ),
    );

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = (input) =>
      Cache.get(providerContextCache, providerDetectionCacheKey(input)).pipe(
        Effect.map(({ context, source }) => {
          const kind = context?.provider.kind ?? "unknown";
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
            contextSource: source,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          SourceControlProviderDiscovery.probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        ),
        { concurrency: "unbounded" },
      ),
    });
  },
);

export const make = Effect.gen(function* () {
  const github = yield* GitHubSourceControlProvider.make;
  const gitlab = yield* GitLabSourceControlProvider.make;
  const bitbucket = yield* BitbucketSourceControlProvider.make;
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery;
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make;
  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
      discovery: GitHubSourceControlProvider.discovery,
    },
    {
      kind: "gitlab",
      provider: gitlab,
      discovery: GitLabSourceControlProvider.discovery,
    },
    {
      kind: "azure-devops",
      provider: azureDevOps,
      discovery: AzureDevOpsSourceControlProvider.discovery,
    },
    {
      kind: "bitbucket",
      provider: bitbucket,
      discovery: bitbucketDiscovery,
    },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
