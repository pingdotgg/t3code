import { Cache, Context, Duration, Effect, Exit, Layer, Option } from "effect";
import {
  SourceControlProviderError,
  type ProjectRemoteOverride,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderInfo,
} from "@t3tools/contracts";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProviderShape;
  readonly discovery: SourceControlProviderDiscovery.SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProviderShape;
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

export interface SourceControlProviderRegistryShape {
  readonly get: (
    kind: SourceControlProviderKind,
  ) => Effect.Effect<SourceControlProvider.SourceControlProviderShape, SourceControlProviderError>;
  readonly resolveHandle: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
  readonly resolve: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProvider.SourceControlProviderShape, SourceControlProviderError>;
  readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("t3/source-control/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.fail(
      new SourceControlProviderError({
        provider: kind,
        operation,
        detail: `No ${kind} source control provider is registered.`,
      }),
    );

  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => unsupported("getRepositoryCloneUrls"),
    createRepository: () => unsupported("createRepository"),
    getDefaultBranch: () => unsupported("getDefaultBranch"),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
  });
}

function providerDetectionError(operation: string, cwd: string, cause: unknown) {
  return new SourceControlProviderError({
    provider: "unknown",
    operation,
    detail: `Failed to detect source control provider for ${cwd}.`,
    cause,
  });
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates = remotes
    .map((remote) => {
      const provider = detectSourceControlProviderFromRemoteUrl(remote.url);
      return provider
        ? {
            provider,
            remoteName: remote.name,
            remoteUrl: remote.url,
          }
        : null;
    })
    .filter((value): value is SourceControlProvider.SourceControlProviderContext => value !== null);

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    return separatorIndex > 0 ? hostWithPath.slice(0, separatorIndex).toLowerCase() : null;
  }

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    const host = parseRemoteHost(value);
    return host ? `https://${host}` : null;
  }
}

function providerName(kind: SourceControlProviderKind, baseUrl: string | null): string {
  switch (kind) {
    case "github":
      return baseUrl === "https://github.com" ? "GitHub" : "GitHub Self-Hosted";
    case "gitlab":
      return baseUrl === "https://gitlab.com" ? "GitLab" : "GitLab Self-Hosted";
    case "azure-devops":
      return "Azure DevOps";
    case "bitbucket":
      return baseUrl === "https://bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted";
    case "unknown":
      return parseRemoteHost(baseUrl ?? "") ?? "Source control";
  }
}

function providerInfoFromOverride(
  override: ProjectRemoteOverride,
): SourceControlProviderInfo | null {
  const baseUrl = override.webUrl
    ? parseBaseUrl(override.webUrl)
    : parseBaseUrl(override.remoteUrl);
  if (!baseUrl) {
    return null;
  }
  return {
    kind: override.provider,
    name: providerName(override.provider, baseUrl),
    baseUrl,
  };
}

function providerContextFromOverride(
  override: ProjectRemoteOverride,
): SourceControlProvider.SourceControlProviderContext | null {
  const provider = providerInfoFromOverride(override);
  return provider
    ? {
        provider,
        remoteName: override.remoteName ?? "origin",
        remoteUrl: override.remoteUrl,
      }
    : null;
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProviderShape,
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProviderShape {
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
      SourceControlProvider.SourceControlProviderShape
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistryShape["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry
          .resolve({ cwd })
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));
        const repository = yield* handle.driver
          .detectRepository(cwd)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const projectOption = yield* projectionSnapshotQuery
          .getActiveProjectByWorkspaceRoot(cwd)
          .pipe(
            Effect.flatMap((project) =>
              Option.isSome(project) || repository === null || repository.rootPath === cwd
                ? Effect.succeed(project)
                : projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(repository.rootPath),
            ),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
        if (Option.isSome(projectOption)) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)),
          );
          const override = settings.projectSettings[projectOption.value.id]?.remoteOverride ?? null;
          const overrideContext = override ? providerContextFromOverride(override) : null;
          if (overrideContext) {
            return overrideContext;
          }
        }

        const remotes = yield* handle.driver
          .listRemotes(cwd)
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));

        return selectProviderContext(remotes.remotes);
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const resolveHandle: SourceControlProviderRegistryShape["resolveHandle"] = (input) =>
      Cache.get(providerContextCache, input.cwd).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? "unknown";
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
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

export const make = Effect.fn("makeSourceControlProviderRegistry")(function* () {
  const github = yield* GitHubSourceControlProvider.make();
  const gitlab = yield* GitLabSourceControlProvider.make();
  const bitbucket = yield* BitbucketSourceControlProvider.make();
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery();
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make();
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

export const layer = Layer.effect(SourceControlProviderRegistry, make());
