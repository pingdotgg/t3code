import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as OriginCli from "./OriginCli.ts";
import { parseOriginAuthStatus } from "./originAuthStatus.ts";
import { originNameWithOwnerFromGitUrl } from "./originPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: OriginCli.OriginPullRequestSummary): ChangeRequest {
  return {
    provider: "cursor-origin",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: summary.updatedAt ?? Option.none(),
  };
}

function nameWithOwnerFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): { readonly nameWithOwner: string } | Record<string, never> {
  if (!context?.remoteUrl) {
    return {};
  }
  const nameWithOwner = originNameWithOwnerFromGitUrl(context.remoteUrl);
  return nameWithOwner ? { nameWithOwner } : {};
}

function parseOriginAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const authStatus = parseOriginAuthStatus(output);
  const host = authStatus.host ?? "origin.cursor.com";

  if (authStatus.account) {
    return providerAuth({
      status: "authenticated",
      account: authStatus.account,
      host,
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `origin auth login` to authenticate Origin CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "Origin CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "cursor-origin",
  label: "Cursor Origin",
  executable: "origin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseOriginAuth,
  installHint:
    "Install the Origin CLI (`origin`) with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, add `~/.local/bin` to PATH, then run `origin auth login`.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const origin = yield* OriginCli.OriginCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "cursor-origin",
    listChangeRequests: (input) =>
      origin
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...nameWithOwnerFromContext(input.context),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "cursor-origin",
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
        ),
    getChangeRequest: (input) =>
      origin
        .getPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...nameWithOwnerFromContext(input.context),
        })
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "cursor-origin",
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
        ),
    createChangeRequest: (input) =>
      origin
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "cursor-origin",
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
        ),
    getRepositoryCloneUrls: (input) =>
      origin.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "cursor-origin",
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
      ),
    createRepository: (input) =>
      origin.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "cursor-origin",
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
    getDefaultBranch: (input) =>
      origin.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "cursor-origin",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      origin.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "cursor-origin",
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
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
