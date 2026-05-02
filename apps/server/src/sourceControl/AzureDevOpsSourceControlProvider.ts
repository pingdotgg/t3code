import { Effect, Layer } from "effect";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import { AzureDevOpsCli, type AzureDevOpsCliError } from "./AzureDevOpsCli.ts";
import { SourceControlProvider } from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

function providerError(operation: string, cause: AzureDevOpsCliError): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "azure-devops",
    operation,
    detail: cause.detail,
    cause,
  });
}

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account && account.length > 0) {
    return providerAuth({ status: "authenticated", account, host: "dev.azure.com" });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "azure-devops",
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  parseAuth: parseAzureAuth,
  implemented: true,
  installHint:
    "Install Azure CLI with `brew install azure-cli`, then add Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
  };
}

function parseAzureDevOpsRepositoryNameFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const httpsMatch =
    /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const sshMatch = /^git@ssh\.dev\.azure\.com:v3\/[^/\s]+\/[^/\s]+\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  const repositoryName = (httpsMatch?.[1] ?? sshMatch?.[1] ?? "").trim();
  return repositoryName.length > 0 ? decodeURIComponent(repositoryName) : null;
}

export const make = Effect.fn("makeAzureDevOpsSourceControlProvider")(function* () {
  const azure = yield* AzureDevOpsCli;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const currentRepositoryName = (cwd: string) =>
    git.readConfigValue(cwd, "remote.origin.url").pipe(
      Effect.map(parseAzureDevOpsRepositoryNameFromRemoteUrl),
      Effect.catch(() => Effect.succeed(null)),
    );

  return SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) =>
      azure.listPullRequests(input).pipe(
        Effect.map((items) => items.map(toChangeRequest)),
        Effect.mapError((error) => providerError("listChangeRequests", error)),
      ),
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) =>
      azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error))),
    getRepositoryCloneUrls: (input) =>
      azure
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    getDefaultBranch: (input) =>
      currentRepositoryName(input.cwd).pipe(
        Effect.flatMap((repository) =>
          repository
            ? azure.getDefaultBranch({ cwd: input.cwd, repository })
            : Effect.succeed(null),
        ),
        Effect.mapError((error) => providerError("getDefaultBranch", error)),
      ),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider, make());
