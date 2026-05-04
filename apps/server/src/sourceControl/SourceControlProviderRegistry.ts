import { Cache, Context, Duration, Effect, Exit, Layer } from "effect";
import { SourceControlProviderError } from "@t3tools/contracts";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  SourceControlProvider,
  type SourceControlProviderContext,
  type SourceControlProviderShape,
} from "./SourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProviderShape;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProviderShape;
  readonly context: SourceControlProviderContext | null;
}

export interface SourceControlProviderRegistryShape {
  readonly get: (
    kind: SourceControlProviderKind,
  ) => Effect.Effect<SourceControlProviderShape, SourceControlProviderError>;
  readonly resolveHandle: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
  readonly resolve: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderShape, SourceControlProviderError>;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("t3/source-control/SourceControlProviderRegistry") {}

function unsupportedProvider(kind: SourceControlProviderKind): SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.fail(
      new SourceControlProviderError({
        provider: kind,
        operation,
        detail: `No ${kind} source control provider is registered.`,
      }),
    );

  return SourceControlProvider.of({
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
): SourceControlProviderContext | null {
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
    .filter((value): value is SourceControlProviderContext => value !== null);

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const vcsRegistry = yield* VcsDriverRegistry;
    const providers = new Map<SourceControlProviderKind, SourceControlProviderShape>(
      registrations.map((registration) => [registration.kind, registration.provider]),
    );

    const get: SourceControlProviderRegistryShape["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry
          .resolve({ cwd })
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));
        const remotes = yield* handle.driver
          .listRemotes(cwd)
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));

        return selectProviderContext(remotes.remotes);
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const resolveHandle: SourceControlProviderRegistryShape["resolveHandle"] = (input) =>
      Cache.get(providerContextCache, input.cwd).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? "unknown";
          return {
            provider: providers.get(kind) ?? unsupportedProvider(kind),
            context,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
    });
  },
);

export const make = Effect.fn("makeSourceControlProviderRegistry")(function* () {
  const github = yield* GitHubSourceControlProvider.make();
  const gitlab = yield* GitLabSourceControlProvider.make();
  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
    },
    {
      kind: "gitlab",
      provider: gitlab,
    },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make());
