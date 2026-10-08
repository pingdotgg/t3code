import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitCafeCli from "./GitCafeCli.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

// Discovery reports the production account; repository operations select their own origin.
const authHost = "git.cafe";
const decodeAuth = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      data: Schema.Struct({ host: Schema.Literal(authHost), username: Schema.NonEmptyString }),
    }),
  ),
);

export const discovery = {
  type: "cli",
  kind: "gitcafe",
  label: "GitCafe",
  executable: "cafe",
  versionArgs: ["--version"],
  authArgs: [...GitCafeCli.CLI_ARGS, "auth", "status", "--json"],
  parseAuth: (input) => {
    const decoded = decodeAuth(input.stdout.trim());
    if (input.exitCode === 0 && Result.isSuccess(decoded))
      return providerAuth({
        status: "authenticated",
        host: authHost,
        account: decoded.success.data.username,
      });
    for (const raw of [input.stderr, input.stdout]) {
      const failure = GitCafeCli.decodeFailure(raw.trim());
      if (Result.isSuccess(failure))
        return providerAuth({
          status:
            failure.success.error.code === "AUTHENTICATION_REQUIRED" ||
            failure.success.error.status === 401
              ? "unauthenticated"
              : "unknown",
          host: authHost,
          detail: failure.success.error.message,
        });
    }
    return providerAuth({
      status: "unknown",
      host: authHost,
      detail: `GitCafe authentication status could not be read. Run \`cafe auth login --host ${GitCafeCli.HOST}\`.`,
    });
  },
  installHint: `Install the GitCafe CLI with \`bun install -g @gitcafe/cli\`, then run \`cafe auth login --host ${GitCafeCli.HOST}\`, or set CAFE_TOKEN on the server.`,
} satisfies SourceControlCliDiscoverySpec;

const decodePrincipal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ handle: Schema.NonEmptyString })),
);

/**
 * GitCafe is usable with `CAFE_TOKEN` alone, which `cafe auth status` knows nothing about, so an
 * environment token is checked against the API, as GitHub's discovery does for `GH_TOKEN`.
 */
export const makeDiscovery = Effect.gen(function* () {
  const cafe = yield* GitCafeCli.GitCafeCli;
  const process = yield* VcsProcess.VcsProcess;
  const environment = yield* HostProcessEnvironment;
  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitCafeSourceControlProvider.discovery")(function* (cwd: string) {
      const cli = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      if (GitCafeCredentials.environmentToken(authHost, environment) === null) return cli;
      const principal = yield* cafe
        .api({ cwd, host: authHost, endpoint: "/auth/principal" })
        .pipe(Effect.result);
      const handle = Result.isSuccess(principal)
        ? Option.getOrUndefined(decodePrincipal(principal.success))?.handle
        : undefined;
      return {
        ...cli,
        status: "available" as const,
        auth:
          handle !== undefined
            ? providerAuth({
                status: "authenticated",
                host: authHost,
                account: handle,
                detail:
                  "Using CAFE_TOKEN from the server environment; it overrides the cafe login.",
              })
            : Result.isFailure(principal) && principal.failure.status !== 401
              ? // Only a refusal says the token is bad; a network error says nothing.
                providerAuth({
                  status: "unknown",
                  host: authHost,
                  detail: `Could not check CAFE_TOKEN: ${principal.failure.detail}`,
                })
              : providerAuth({
                  status: "unauthenticated",
                  host: authHost,
                  detail:
                    "GitCafe refused CAFE_TOKEN. Replace it, or unset it to use `cafe auth login`.",
                }),
      } satisfies SourceControlProviderDiscoveryItem;
    }),
    // GitCafe lives on two fixed hosts, which remote detection already recognizes.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const cafe = yield* GitCafeCli.GitCafeCli;
  const mapError = (operation: string, cwd: string) => (error: GitCafeCli.GitCafeCliError) =>
    new SourceControlProviderError({
      provider: "gitcafe",
      operation,
      cwd,
      command: error.command,
      detail: error.detail,
      cause: error,
    });
  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitcafe",
    listChangeRequests: (input) =>
      cafe
        .listChangeRequests(input)
        .pipe(Effect.mapError(mapError("listChangeRequests", input.cwd))),
    getChangeRequest: (input) =>
      cafe.getChangeRequest(input).pipe(Effect.mapError(mapError("getChangeRequest", input.cwd))),
    createChangeRequest: (input) =>
      cafe
        .createChangeRequest(input)
        .pipe(Effect.mapError(mapError("createChangeRequest", input.cwd))),
    getRepositoryCloneUrls: (input) =>
      cafe
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError(mapError("getRepositoryCloneUrls", input.cwd))),
    createRepository: (input) =>
      cafe.createRepository(input).pipe(Effect.mapError(mapError("createRepository", input.cwd))),
    getDefaultBranch: (input) =>
      cafe.getDefaultBranch(input).pipe(Effect.mapError(mapError("getDefaultBranch", input.cwd))),
    checkoutChangeRequest: (input) =>
      cafe
        .checkoutChangeRequest(input)
        .pipe(Effect.mapError(mapError("checkoutChangeRequest", input.cwd))),
  });
});
