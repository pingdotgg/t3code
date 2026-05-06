import { Context, Effect, Layer } from "effect";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderKind,
} from "@forma/contracts";

import { ServerConfig } from "../config.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProviderShape;
  readonly discovery: SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;
}

export interface SourceControlProviderRegistryShape {
  readonly get: (
    kind: SourceControlProviderKind,
  ) => Effect.Effect<SourceControlProviderShape, SourceControlProviderError>;
  readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("forma/source-control/SourceControlProviderRegistry") {}

function unsupportedProvider(kind: SourceControlProviderKind): SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.fail(
      new SourceControlProviderError({
        provider: kind,
        operation,
        detail: `No ${kind} source control provider is registered.`,
      }),
    );

  return {
    kind,
    getRepositoryCloneUrls: () => unsupported("getRepositoryCloneUrls"),
    createRepository: () => unsupported("createRepository"),
  };
}

export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const providers = new Map<SourceControlProviderKind, SourceControlProviderShape>(
      registrations.map((registration) => [registration.kind, registration.provider]),
    );
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    return SourceControlProviderRegistry.of({
      get: (kind) => Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          SourceControlProviderDiscovery.probeSourceControlProvider({
            spec,
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
  ]);
});

export const SourceControlProviderRegistryLive = Layer.effect(
  SourceControlProviderRegistry,
  make(),
);
