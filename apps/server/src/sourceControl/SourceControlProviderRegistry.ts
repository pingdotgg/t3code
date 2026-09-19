import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import type { SourceControlProviderInfo, SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type SourceControlProviderDiscoverySpec,
  type UnknownRemoteRefinement,
} from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);
// Refining an unknown remote spawns every hosting CLI, and the answer belongs to the host
// rather than to a checkout. Keeping the verdict - including "nobody claimed it" - for a few
// minutes is what stops a workspace of projects on one unrecognised host from re-probing the
// CLIs on every read. The window is the delay before newly authenticated CLIs are noticed.
const UNKNOWN_REMOTE_CACHE_CAPACITY = 512;
const UNKNOWN_REMOTE_CACHE_TTL = Duration.minutes(5);

/** No host verdict this time. Failing keeps the attempt out of the cache. */
class UnsettledRemote {
  readonly _tag = "UnsettledRemote";
}

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
  /**
   * The remote's provider was settled for the host: another checkout of the same host cannot
   * refine it further. Optional so narrow test doubles stay lightweight; absent reads as "not
   * settled", which keeps callers walking to the next checkout.
   */
  readonly conclusive?: boolean;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly resolveLink: SourceControlProvider.ResolveSourceControlLink;
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
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

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
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
    ...(provider.resolveLink ? { resolveLink: provider.resolveLink } : {}),
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

/** @public Service construction is part of the canonical Effect module API. */
export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const process = yield* VcsProcess.VcsProcess;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const unknownRemoteKey = (
      context: SourceControlProvider.SourceControlProviderContext,
    ): string | null => {
      // The host, not the checkout, is what the refinement answers about. A requested host
      // narrows a Forgejo login match, so it belongs in the key too.
      const host = detectSourceControlProviderFromRemoteUrl(context.remoteUrl)?.baseUrl;
      return host === undefined ? null : `${host}\u0000${context.requestedHost ?? ""}`;
    };

    // Any checkout of a host is an equally good place to ask from, so the lookup takes the
    // request that most recently asked for this key. `Cache.get` collapses concurrent misses
    // into one probe, and a refinement that settled nothing fails so it is not cached.
    const unknownRemoteRequests = new Map<
      string,
      {
        readonly cwd: string;
        readonly context: SourceControlProvider.SourceControlProviderContext;
      }
    >();

    const unknownRemoteCache = yield* Cache.makeWith<
      string,
      SourceControlProviderInfo | null,
      UnsettledRemote
    >(
      (key) =>
        Effect.suspend(() => {
          const request = unknownRemoteRequests.get(key);
          if (request === undefined) return Effect.fail(new UnsettledRemote());
          return refineUnknownRemoteProvider({
            specs: discoverySpecs,
            process,
            cwd: request.cwd,
            context: request.context,
          }).pipe(
            Effect.flatMap((refinement) =>
              refinement.conclusive
                ? Effect.succeed(refinement.context?.provider ?? null)
                : Effect.fail(new UnsettledRemote()),
            ),
          );
        }),
      {
        capacity: UNKNOWN_REMOTE_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? UNKNOWN_REMOTE_CACHE_TTL : Duration.zero),
      },
    );

    const refineWithHostCache = Effect.fn("SourceControlProviderRegistry.refineUnknownRemote")(
      function* (input: {
        readonly cwd: string;
        readonly context: SourceControlProvider.SourceControlProviderContext | null;
      }): Effect.fn.Return<UnknownRemoteRefinement> {
        const context = input.context;
        if (context === null || context.provider.kind !== "unknown") {
          return { context, conclusive: context !== null };
        }
        const key = unknownRemoteKey(context);
        if (key === null) {
          return yield* refineUnknownRemoteProvider({
            specs: discoverySpecs,
            process,
            cwd: input.cwd,
            context,
          });
        }
        const request = { cwd: input.cwd, context };
        unknownRemoteRequests.set(key, request);
        const provider = yield* Cache.get(unknownRemoteCache, key).pipe(
          Effect.option,
          Effect.ensuring(
            // Retire only our own request. An unsettled lookup drops its zero-lived cache
            // entry before this runs, so a later call may already have installed the request
            // its own lookup is about to read.
            Effect.sync(() => {
              if (unknownRemoteRequests.get(key) === request) unknownRemoteRequests.delete(key);
            }),
          ),
        );
        if (Option.isNone(provider)) return { context, conclusive: false };
        return {
          context: provider.value === null ? context : { ...context, provider: provider.value },
          conclusive: true,
        };
      },
    );

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
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

        const refinement = yield* refineWithHostCache({ cwd, context });
        return refinement.context;
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

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = (input) =>
      (input.context === undefined
        ? // The per-cwd cache keeps only the context, so this path reports no host verdict.
          Cache.get(providerContextCache, input.cwd).pipe(
            Effect.map((context): UnknownRemoteRefinement => ({ context, conclusive: false })),
          )
        : refineWithHostCache({ cwd: input.cwd, context: input.context })
      ).pipe(
        Effect.map(({ context, conclusive }) => {
          const kind = context?.provider.kind ?? "unknown";
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
            conclusive,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      resolveLink: (input) => {
        if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
          return undefined;
        }
        const kind = detectSourceControlProviderFromRemoteUrl(input.url.href)?.kind;
        return kind ? providers.get(kind)?.resolveLink?.(input) : undefined;
      },
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          probeSourceControlProvider({
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
  const forgejo = yield* ForgejoSourceControlProvider.make;
  const forgejoDiscovery = yield* ForgejoSourceControlProvider.makeDiscovery;
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
    { kind: "forgejo", provider: forgejo, discovery: forgejoDiscovery },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
