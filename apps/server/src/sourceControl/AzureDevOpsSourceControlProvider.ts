import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
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
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
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
    isCrossRepository: summary.isCrossRepository ?? false,
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

/** Parses the repository coordinates carried by a provider source-control context. */
function parseRepositoryContext(input: {
  readonly context?: SourceControlProvider.SourceControlProviderContext;
}) {
  return input.context
    ? AzureDevOpsCli.parseAzureDevOpsRemoteUrl(input.context.remoteUrl)
    : undefined;
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(repositoryContext ? { repositoryContext } : {}),
          ...(source !== undefined ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) => {
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .getPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(repositoryContext ? { repositoryContext } : {}),
        })
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "getChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(repositoryContext ? { repositoryContext } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) => {
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .getRepositoryCloneUrls({
          cwd: input.cwd,
          repository: input.repository,
          ...(repositoryContext ? { repositoryContext } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "getRepositoryCloneUrls",
                command: error.command,
                cwd: input.cwd,
                repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.repository,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    createRepository: (input) =>
      azure.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) => {
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .getDefaultBranch({
          cwd: input.cwd,
          ...(repositoryContext ? { repositoryContext } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    checkoutChangeRequest: (input) => {
      const repositoryContext = parseRepositoryContext(input);
      return azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(repositoryContext ? { repositoryContext } : {}),
          ...(input.context !== undefined
            ? { remoteName: input.context.remoteName, remoteUrl: input.context.remoteUrl }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
