import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChangeRequest } from "@t3tools/contracts";

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

function azureRepositoryFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): { readonly repository: string; readonly project?: string } | undefined {
  if (!context) return undefined;
  const path = SourceControlProvider.repositoryPathFromRemoteUrl(context.remoteUrl);
  if (!path) return undefined;
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  const gitProject = parts[gitIndex - 1];
  const gitRepository = parts[gitIndex + 1];
  if (gitIndex >= 1 && gitProject && gitRepository) {
    return { project: gitProject, repository: gitRepository };
  }
  const sshProject = parts[2];
  const sshRepository = parts[3];
  if (parts[0]?.toLowerCase() === "v3" && sshProject && sshRepository) {
    return { project: sshProject, repository: sshRepository };
  }
  const fallbackProject = parts.at(-2);
  const repository = parts.at(-1);
  return repository
    ? { repository, ...(fallbackProject ? { project: fallbackProject } : {}) }
    : undefined;
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const repository = azureRepositoryFromContext(input.context);
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(repository !== undefined ? repository : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: "azure-devops",
              operation: "listChangeRequests",
              cwd: input.cwd,
              reference: input.headSelector,
              error,
            }),
          ),
        );
    },
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) =>
          SourceControlProvider.sourceControlProviderError({
            provider: "azure-devops",
            operation: "getChangeRequest",
            cwd: input.cwd,
            reference: input.reference,
            error,
          }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: "azure-devops",
              operation: "createChangeRequest",
              cwd: input.cwd,
              reference: input.headSelector,
              error,
            }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      azure.getRepositoryCloneUrls(input).pipe(
        Effect.mapError((error) =>
          SourceControlProvider.sourceControlProviderError({
            provider: "azure-devops",
            operation: "getRepositoryCloneUrls",
            cwd: input.cwd,
            repository: input.repository,
            error,
          }),
        ),
      ),
    getCommitAvatarUrl: (input) => {
      const repository = azureRepositoryFromContext(input.context);
      if (!repository) {
        return Effect.succeed(null);
      }
      return azure
        .getCommitAvatarUrl({
          cwd: input.cwd,
          ...repository,
          sha: input.sha,
        })
        .pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: "azure-devops",
              operation: "getCommitAvatarUrl",
              cwd: input.cwd,
              reference: input.sha,
              error,
            }),
          ),
        );
    },
    createRepository: (input) =>
      azure.createRepository(input).pipe(
        Effect.mapError((error) =>
          SourceControlProvider.sourceControlProviderError({
            provider: "azure-devops",
            operation: "createRepository",
            cwd: input.cwd,
            repository: input.repository,
            error,
          }),
        ),
      ),
    getDefaultBranch: (input) =>
      azure.getDefaultBranch({ cwd: input.cwd }).pipe(
        Effect.mapError((error) =>
          SourceControlProvider.sourceControlProviderError({
            provider: "azure-devops",
            operation: "getDefaultBranch",
            cwd: input.cwd,
            error,
          }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: "azure-devops",
              operation: "checkoutChangeRequest",
              cwd: input.cwd,
              reference: input.reference,
              error,
            }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
