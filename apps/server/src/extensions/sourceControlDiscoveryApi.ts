import {
  ExtensionOperationError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import {
  sourceControlDiscoveryApi,
  type RepositoryList,
  type SourceControlKind,
} from "@t3tools/extension-sdk/catalogue";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { listSourceControlRepositories } from "../sourceControl/RepositoryListing.ts";
import { assertCloneAuthority } from "./projectsCloneApi.ts";
import { lookupExtensionRepository } from "./repositoryLookup.ts";

const providerKind = Schema.Literals(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"]);
const listInput = Schema.Struct({ provider: providerKind });
const lookupInput = Schema.Struct({
  provider: providerKind,
  repository: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
const decodeDiscover = Schema.decodeUnknownSync(Schema.Struct({}), { onExcessProperty: "error" });
const decodeList = Schema.decodeUnknownSync(listInput, { onExcessProperty: "error" });
const decodeLookup = Schema.decodeUnknownSync(lookupInput, { onExcessProperty: "error" });
const fail = (method?: string) =>
  new ExtensionOperationError({
    operation: "source-control.discovery",
    detail:
      method === "lookupRepository"
        ? "Repository lookup failed. Check the repository name and provider access."
        : "Source control discovery is unavailable. Open Settings -> Source Control and rescan.",
  });

export function projectSourceControlDiscovery(
  providers: readonly SourceControlProviderDiscoveryItem[],
) {
  return {
    providers: providers.map((provider) => ({
      kind: provider.kind,
      label: provider.label,
      status: provider.status,
      authStatus: provider.auth.status,
      account: Option.getOrNull(provider.auth.account),
      ready:
        provider.status === "available" &&
        provider.auth.status !== "unauthenticated" &&
        provider.kind !== "unknown",
      hint:
        provider.status !== "available"
          ? provider.installHint
          : provider.auth.status === "unauthenticated"
            ? (Option.getOrNull(provider.auth.detail) ??
              `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`)
            : null,
    })),
  };
}

export function createSourceControlDiscoveryApiProvider(dependencies: {
  readonly environmentId: string;
  readonly cwd: string;
  readonly discovery: Pick<
    SourceControlProviderRegistry["Service"],
    "discover" | "get" | "repositoryHosts"
  >;
  readonly listRepositories: (input: {
    readonly provider: SourceControlKind;
    readonly cwd: string;
  }) => Effect.Effect<RepositoryList, Error>;
}): HostApiProvider {
  return {
    providerId: "host.source-control-discovery",
    definition: sourceControlDiscoveryApi.definition,
    requiresRootAuthority: true,
    async invoke(method, input, context, signal, metadata) {
      const assertAuthority = assertCloneAuthority(
        dependencies.environmentId,
        context,
        metadata,
        false,
      );
      signal.throwIfAborted();
      await assertAuthority();
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(effect.pipe(Effect.mapError(() => fail(method))), { signal });
      if (method === "discover") {
        try {
          decodeDiscover(input);
        } catch {
          throw fail();
        }
        return projectSourceControlDiscovery(await run(dependencies.discovery.discover));
      }
      if (method !== "lookupRepository" && method !== "listRepositories") throw fail();
      let request;
      try {
        request = method === "lookupRepository" ? decodeLookup(input) : decodeList(input);
      } catch {
        throw fail(method);
      }
      await assertAuthority();
      if (method === "listRepositories")
        return run(
          dependencies.listRepositories({ provider: request.provider, cwd: dependencies.cwd }),
        );
      if (!("repository" in request) || typeof request.repository !== "string") throw fail();
      const repository = await run(
        lookupExtensionRepository(dependencies.discovery, {
          provider: request.provider,
          repository: request.repository,
          cwd: dependencies.cwd,
        }),
      );
      await assertAuthority();
      return repository;
    },
  };
}

export const makeSourceControlDiscoveryApiProvider = Effect.fn("SourceControlDiscoveryApi.make")(
  function* () {
    const config = yield* ServerConfig;
    const environment = yield* ServerEnvironment;
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof listSourceControlRepositories>>>();
    return createSourceControlDiscoveryApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      cwd: config.cwd,
      discovery: yield* SourceControlProviderRegistry,
      listRepositories: (input) =>
        listSourceControlRepositories(input).pipe(Effect.provideContext(context)),
    });
  },
);
