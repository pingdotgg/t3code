import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SourceControlProviderError } from "@t3tools/contracts";

import type { SourceControlApiDiscoverySpec } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import { repositoryNameFromRemoteUrl, definition } from "../shared/definition.ts";
import * as BitbucketServerApi from "./BitbucketServerApi.ts";

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    repositoryNameFromRemoteUrl,
    refineRepositoryIdentity: Effect.fn(
      "BitbucketServerSourceControlProvider.refineRepositoryIdentity",
    )(function* ({ identity }) {
      if (
        identity.provider !== undefined &&
        identity.provider !== "unknown" &&
        identity.provider !== definition.kind
      )
        return identity;
      const remote = yield* bitbucket.resolveRemote(identity.locator.remoteUrl);
      if (!remote) return identity;
      const [owner, name] = remote.repository.split("/");
      return {
        ...identity,
        provider: definition.kind,
        displayName: remote.repository,
        ...(owner ? { owner } : {}),
        ...(name ? { name } : {}),
        webUrl: `${remote.baseUrl}/projects/${encodeURIComponent(owner ?? "")}/repos/${encodeURIComponent(name ?? "")}`,
      };
    }),
    resolveRemoteWebHost: Effect.fn("BitbucketServerSourceControlProvider.resolveRemoteWebHost")(
      ({ context }) =>
        bitbucket
          .resolveRemote(context.remoteUrl)
          .pipe(Effect.map((remote) => (remote ? new URL(remote.baseUrl).host : null))),
    ),
    listChangeRequests: Effect.fn("BitbucketServerSourceControlProvider.listChangeRequests")(
      (input) => {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return bitbucket
          .listPullRequests({
            cwd: input.cwd,
            ...(input.context ? { context: input.context } : {}),
            headSelector: input.headSelector,
            ...(source ? { source } : {}),
            state: input.state,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map((item) => ({ ...item, provider: definition.kind }))),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: definition.kind,
                  operation: "listChangeRequests",
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: "Failed to list change requests.",
                  cause: error,
                }),
            ),
          );
      },
    ),
    getChangeRequest: Effect.fn("BitbucketServerSourceControlProvider.getChangeRequest")((input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map((item) => ({ ...item, provider: definition.kind })),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: definition.kind,
              operation: "getChangeRequest",
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: "Failed to get change request.",
              cause: error,
            }),
        ),
      ),
    ),
    createChangeRequest: Effect.fn("BitbucketServerSourceControlProvider.createChangeRequest")(
      (input) => {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return bitbucket
          .createPullRequest({
            cwd: input.cwd,
            ...(input.context ? { context: input.context } : {}),
            baseBranch: input.baseRefName,
            headSelector: input.headSelector,
            ...(source ? { source } : {}),
            ...(input.target ? { target: input.target } : {}),
            title: input.title,
            bodyFile: input.bodyFile,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: definition.kind,
                  operation: "createChangeRequest",
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: "Failed to create change request.",
                  cause: error,
                }),
            ),
          );
      },
    ),
    getRepositoryCloneUrls: Effect.fn(
      "BitbucketServerSourceControlProvider.getRepositoryCloneUrls",
    )((input) =>
      bitbucket.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: definition.kind,
              operation: "getRepositoryCloneUrls",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to get repository clone URLs.",
              cause: error,
            }),
        ),
      ),
    ),
    createRepository: Effect.fn("BitbucketServerSourceControlProvider.createRepository")((input) =>
      bitbucket.createRepository(input).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: definition.kind,
              operation: "createRepository",
              cwd: input.cwd,
              detail: "Failed to create repository.",
              cause,
            }),
        ),
      ),
    ),
    getDefaultBranch: Effect.fn("BitbucketServerSourceControlProvider.getDefaultBranch")((input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: definition.kind,
                operation: "getDefaultBranch",
                cwd: input.cwd,
                detail: "Failed to get default branch.",
                cause: error,
              }),
          ),
        ),
    ),
    checkoutChangeRequest: Effect.fn("BitbucketServerSourceControlProvider.checkoutChangeRequest")(
      (input) =>
        bitbucket
          .checkoutPullRequest({
            cwd: input.cwd,
            ...(input.context ? { context: input.context } : {}),
            reference: input.reference,
            ...(input.force !== undefined ? { force: input.force } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: definition.kind,
                  operation: "checkoutChangeRequest",
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.reference,
                  ),
                  detail: "Failed to check out change request.",
                  cause: error,
                }),
            ),
          ),
    ),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  return {
    type: "api",
    refineUnknownRemote: ({ context }) =>
      bitbucket
        .resolveRemote(context.remoteUrl)
        .pipe(
          Effect.map((remote) =>
            remote
              ? { kind: definition.kind, name: definition.label, baseUrl: remote.baseUrl }
              : null,
          ),
        ),
    kind: definition.kind,
    label: "Bitbucket Data Center",
    installHint: "Add a Bitbucket Data Center host and token in Settings → Source Control.",
    // Settings show only the setup hint for an unauthenticated API integration, so a token the
    // host refused (a host is only reported once one is configured) reports as unverified there.
    probeAuth: bitbucket.probeAuth.pipe(
      Effect.map((auth) =>
        auth.status === "unauthenticated" && Option.isSome(auth.host)
          ? { ...auth, status: "unknown" as const }
          : auth,
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});
