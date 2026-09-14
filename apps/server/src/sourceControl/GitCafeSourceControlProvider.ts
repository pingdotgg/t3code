import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SourceControlProviderError } from "@t3tools/contracts";

import * as GitCafeCli from "./GitCafeCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
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
  installHint: `Install the GitCafe CLI with \`bun install -g @gitcafe/cli\`, then run \`cafe auth login --host ${GitCafeCli.HOST}\`.`,
} satisfies SourceControlCliDiscoverySpec;

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
