import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { decodeViewerJson } from "./azureDevOpsPullRequestJson.ts";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import type { NormalizedAzureDevOpsPullRequestRecord } from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";

// A nonzero exit is only a sign-in problem when Azure says so. Network, service, and CLI
// failures leave the status indeterminate so a signed-in user is not told to log in again.
const AZURE_AUTH_FAILURE =
  /\baz (?:devops )?login\b|authentication failed|unauthori[sz]ed|\b401\b|TF400813|personal access token/i;

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);

  if (input.exitCode !== 0) {
    return providerAuth({
      status: AZURE_AUTH_FAILURE.test(output) ? "unauthenticated" : "unknown",
      detail: firstSafeAuthLine(output) ?? "Run `az devops login` to authenticate Azure DevOps.",
    });
  }

  const decoded = decodeViewerJson(input.stdout);
  const viewer = Result.isSuccess(decoded) ? decoded.success : null;

  if (viewer?._tag === "Anonymous") {
    return providerAuth({
      status: "unauthenticated",
      host: "dev.azure.com",
      detail: "Run `az devops login` to authenticate Azure DevOps.",
    });
  }

  if (viewer?._tag === "SignedIn" && viewer.account !== null) {
    return providerAuth({
      status: "authenticated",
      account: viewer.account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure DevOps did not return an authenticated identity.",
  });
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: AzureDevOpsCli.connectionDataArgs,
  // `az --version` starts Python and takes ~6s on Windows, exceeding the default probe timeout.

  probeTimeoutMs: 20_000,
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: NormalizedAzureDevOpsPullRequestRecord): ChangeRequest {
  return {
    provider: SourceControlProviderKind.make("azure-devops"),
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    isCrossRepository: summary.isCrossRepository,
  };
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops"),
    listChangeRequests: Effect.fn("AzureDevOpsSourceControlProvider.listChangeRequests")(
      function (input) {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return azure
          .listPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(source !== undefined ? { source } : {}),
            state: input.state,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
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
    ),
    getChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.getChangeRequest")(
      function (input) {
        return azure.getPullRequest(input).pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
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
    ),
    createChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.createChangeRequest")(
      function (input) {
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
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
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
    ),
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsSourceControlProvider.getRepositoryCloneUrls")(
      function (input) {
        return azure.getRepositoryCloneUrls(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
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
    ),
    createRepository: Effect.fn("AzureDevOpsSourceControlProvider.createRepository")(
      function (input) {
        return azure.createRepository(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
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
        );
      },
    ),
    getDefaultBranch: Effect.fn("AzureDevOpsSourceControlProvider.getDefaultBranch")(
      function (input) {
        return azure.getDefaultBranch({ cwd: input.cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.detail,
                cause: error,
              }),
          ),
        );
      },
    ),
    checkoutChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.checkoutChangeRequest")(
      function (input) {
        return azure
          .checkoutPullRequest({
            cwd: input.cwd,
            reference: input.reference,
            ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
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
    ),
  });
});
