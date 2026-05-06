import { Effect } from "effect";
import { SourceControlProviderError } from "@forma/contracts";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

function providerError(operation: string, cause: unknown): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation,
    detail:
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "GitHub source control operation failed.",
    cause,
  });
}

function parseGitHubAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const output = SourceControlProviderDiscovery.combinedAuthOutput(input);
  const account = SourceControlProviderDiscovery.matchFirst(output, [
    /Logged in to .* account\s+([^\s(]+)/iu,
    /Logged in to .* as\s+([^\s(]+)/iu,
  ]);
  const host = SourceControlProviderDiscovery.parseCliHost(output);

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host,
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
        "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  if (account) {
    return SourceControlProviderDiscovery.providerAuth({ status: "authenticated", account, host });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host,
    detail:
      SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
      "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) from https://cli.github.com/ or your package manager.",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export const make = Effect.fn("makeGitHubSourceControlProvider")(function* () {
  const github = yield* GitHubCli;

  return {
    kind: "github",
    getRepositoryCloneUrls: (input) =>
      github
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) => {
      const visibilityArg = input.visibility === "private" ? "--private" : "--public";
      const createWithFlag = (confirmFlag: "--confirm" | "--yes") =>
        github.execute({
          cwd: input.cwd,
          args: ["repo", "create", input.repository, visibilityArg, confirmFlag],
          timeoutMs: 60_000,
        });

      return createWithFlag("--confirm").pipe(
        Effect.catch((error) => {
          const detail = error.detail.toLowerCase();
          if (detail.includes("unknown flag") && detail.includes("confirm")) {
            return createWithFlag("--yes");
          }
          return Effect.fail(error);
        }),
        Effect.flatMap(() =>
          github.getRepositoryCloneUrls({
            cwd: input.cwd,
            repository: input.repository,
          }),
        ),
        Effect.mapError((error) => providerError("createRepository", error)),
      );
    },
  } satisfies SourceControlProviderShape;
});
