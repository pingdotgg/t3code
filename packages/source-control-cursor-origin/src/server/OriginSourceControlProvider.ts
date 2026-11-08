import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import { CURSOR_ORIGIN_WEB_BASE_URL, parseChangeRequestUrl } from "../shared/definition.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";

import * as OriginCli from "./OriginCli.ts";
import {
  OriginPullRequestListSchema,
  OriginPullRequestSchema,
  OriginRepositorySchema,
  toOriginChangeRequest,
  type OriginRepository,
} from "./originPullRequests.ts";

const isOriginCliError = Schema.is(OriginCli.OriginCliError);

const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("cursor-origin"),
  label: "Cursor Origin",
  executable: OriginCli.ORIGIN_COMMAND,
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  parseAuth: (input) => {
    const status = OriginCli.parseOriginAuthStatus(input.stdout);
    const account = OriginCli.originAccount(status);
    if (status === null) return providerAuth({ status: "unknown" });
    return status.authenticated && status.tokenValid !== false
      ? providerAuth({
          status: "authenticated",
          account: account ?? undefined,
          host: "origin.cursor.com",
        })
      : providerAuth({
          status: "unauthenticated",
          detail: "Run `origin auth login` to sign in to Cursor Origin.",
        });
  },
  installHint:
    "Install the Origin CLI with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then run `origin auth login`.",
} satisfies SourceControlCliDiscoverySpec;

/**
 * Discovery names the account by its namespace slug, which is what owns its repositories (and so
 * what Publish fills in), rather than the email `origin auth status` reports.
 */
export const makeDiscovery = Effect.gen(function* () {
  const cli = yield* OriginCli.OriginCli;
  const { process } = yield* SourceControlHost.SourceControlHost;
  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("OriginSourceControlProvider.discovery")(function* (cwd: string) {
      const item = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      if (item.status !== "available" || item.auth.status !== "authenticated") return item;
      const namespace = yield* cli.personalNamespace(cwd).pipe(Effect.option);
      return { ...item, auth: { ...item.auth, account: namespace } };
    }),
    // `origin.cursor.com` is recognised from the remote alone, so there is nothing to refine.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

/** `42`, `#42`, or a `cursor.com/codebase/…/pull/42` URL. */
function originPullNumber(reference: string): number | null {
  const match = /(?:^#?|\/pull\/)(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/u.exec(reference.trim());
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** A cursor.com pull request URL names its own repository, which need not be the checkout's. */
function pullReference(reference: string) {
  const trimmed = reference.trim();
  const link = URL.canParse(trimmed) ? parseChangeRequestUrl(new URL(trimmed)) : null;
  return {
    repository: link?.repository ?? null,
    number: link?.number ?? originPullNumber(trimmed),
  };
}

const cloneUrls = (repository: OriginRepository, fallbackName: string) => {
  const nameWithOwner =
    repository.fullName ??
    (repository.owner ? `${repository.owner.slug}/${repository.name}` : fallbackName);
  const url = repository.cloneUrl ?? `https://origin.cursor.com/${nameWithOwner}.git`;
  // Origin documents no SSH clone URL, and `origin auth login` already configures git's HTTPS
  // credential helper, so HTTPS stands in for both.
  return { nameWithOwner, url, sshUrl: url };
};

export const make = Effect.gen(function* () {
  const cli = yield* OriginCli.OriginCli;
  const fs = yield* FileSystem.FileSystem;
  const { git } = yield* SourceControlHost.SourceControlHost;

  const mapError = (
    operation: string,
    cwd: string,
    extra?: { readonly repository?: string; readonly reference?: string },
  ) =>
    Effect.mapError(
      (cause: unknown) =>
        new SourceControlProviderError({
          provider: SourceControlProviderKind.make("cursor-origin"),
          operation,
          cwd,
          command: OriginCli.ORIGIN_COMMAND,
          ...(extra?.repository
            ? {
                repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                  extra.repository,
                ),
              }
            : {}),
          ...(extra?.reference
            ? {
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  extra.reference,
                ),
              }
            : {}),
          detail: isOriginCliError(cause) ? cause.detail : "Cursor Origin operation failed.",
          cause,
        }),
    );

  const getRepository = (cwd: string, repository: string, operation: string) =>
    cli.api(
      { cwd, operation, path: OriginCli.originRepositoryPath(repository) },
      OriginRepositorySchema,
    );

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("cursor-origin"),

    /** Origin's browser pages live on cursor.com, not on the git host the remote names. */
    refineRepositoryIdentity: Effect.fn("OriginSourceControlProvider.refineRepositoryIdentity")(
      ({ identity }) => {
        const path = SourceControlProvider.repositoryPathFromRemoteUrl(identity.locator.remoteUrl);
        return Effect.succeed(
          identity.provider === "cursor-origin" && path
            ? { ...identity, webUrl: `${CURSOR_ORIGIN_WEB_BASE_URL}/${path}` }
            : identity,
        );
      },
    ),

    listChangeRequests: Effect.fn("OriginSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repository = yield* cli.resolveRepository(input);
        const head = SourceControlProvider.sourceBranch(input);
        const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
        const query = new URLSearchParams({
          head,
          state: input.state,
          pageSize: String(limit),
          sortBy: "updated",
        });
        const page = yield* cli.api(
          {
            cwd: input.cwd,
            operation: "listChangeRequests",
            path: `${OriginCli.originRepositoryPath(repository)}/pulls?${query}`,
          },
          OriginPullRequestListSchema,
        );
        return (page.pullRequests ?? []).map(toOriginChangeRequest);
      },
      (effect, input) =>
        effect.pipe(mapError("listChangeRequests", input.cwd, { reference: input.headSelector })),
    ),

    getChangeRequest: Effect.fn("OriginSourceControlProvider.getChangeRequest")(
      function* (input) {
        const reference = pullReference(input.reference);
        const repository = reference.repository ?? (yield* cli.resolveRepository(input));
        const number = reference.number;
        if (number === null)
          return yield* new OriginCli.OriginCliError({
            operation: "getChangeRequest",
            cwd: input.cwd,
            reason: "not-found",
            detail: "Specify a pull request number or Cursor Origin pull request URL.",
          });
        return toOriginChangeRequest(
          yield* cli.api(
            {
              cwd: input.cwd,
              operation: "getChangeRequest",
              path: `${OriginCli.originRepositoryPath(repository)}/pulls/${number}`,
            },
            OriginPullRequestSchema,
          ),
        );
      },
      (effect, input) =>
        effect.pipe(mapError("getChangeRequest", input.cwd, { reference: input.reference })),
    ),

    createChangeRequest: Effect.fn("OriginSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repository = input.target?.repository ?? (yield* cli.resolveRepository(input));
        // Origin creates drafts unless told otherwise; T3 asks for draft explicitly elsewhere.
        yield* cli.api(
          {
            cwd: input.cwd,
            operation: "createChangeRequest",
            method: "POST",
            path: `${OriginCli.originRepositoryPath(repository)}/pulls`,
            body: {
              title: input.title,
              body: yield* fs.readFileString(input.bodyFile),
              head: SourceControlProvider.sourceBranch(input),
              base: input.target?.refName ?? input.baseRefName,
              draft: false,
            },
          },
          Schema.Unknown,
        );
      },
      (effect, input) =>
        effect.pipe(mapError("createChangeRequest", input.cwd, { reference: input.headSelector })),
    ),

    getRepositoryCloneUrls: Effect.fn("OriginSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repository = yield* getRepository(
          input.cwd,
          input.repository,
          "getRepositoryCloneUrls",
        );
        return cloneUrls(repository, input.repository);
      },
      (effect, input) =>
        effect.pipe(
          mapError("getRepositoryCloneUrls", input.cwd, { repository: input.repository }),
        ),
    ),

    createRepository: Effect.fn("OriginSourceControlProvider.createRepository")(
      function* (input) {
        if (input.visibility === "public")
          return yield* new OriginCli.OriginCliError({
            operation: "createRepository",
            cwd: input.cwd,
            reason: "failed",
            detail: "Cursor Origin repositories are private. Choose private visibility.",
          });
        const parts = input.repository.split("/");
        if (parts.length > 2 || parts.some((part) => part.trim().length === 0))
          return yield* new OriginCli.OriginCliError({
            operation: "createRepository",
            cwd: input.cwd,
            reason: "failed",
            detail: "Specify an Origin repository as owner/name or name.",
          });
        const [owner, name] =
          parts.length === 2 ? parts : [yield* cli.personalNamespace(input.cwd), input.repository];
        yield* cli.api(
          {
            cwd: input.cwd,
            operation: "createRepository",
            method: "POST",
            path: `/v1/origin/repos/${encodeURIComponent(owner ?? "")}`,
            body: { name },
          },
          OriginRepositorySchema,
        );
        // Origin creates repositories internal (visible to the whole team) and only takes a
        // visibility on update, so the repository is made private straight after.
        const madePrivate = yield* cli
          .api(
            {
              cwd: input.cwd,
              operation: "createRepository",
              method: "PATCH",
              path: OriginCli.originRepositoryPath(`${owner}/${name}`),
              body: { visibility: "private" },
            },
            OriginRepositorySchema,
          )
          .pipe(
            Effect.retry({ times: 2 }),
            Effect.mapError(
              (cause) =>
                new OriginCli.OriginCliError({
                  operation: "createRepository",
                  cwd: input.cwd,
                  reason: "failed",
                  detail: `Created ${owner}/${name}, but could not make it private, so your Cursor team can still see it. Set it to private on cursor.com.`,
                  cause,
                }),
            ),
          );
        return cloneUrls(madePrivate, `${owner}/${name}`);
      },
      (effect, input) =>
        effect.pipe(mapError("createRepository", input.cwd, { repository: input.repository })),
    ),

    getDefaultBranch: Effect.fn("OriginSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const repository = yield* cli.resolveRepository(input);
        return (
          (yield* getRepository(input.cwd, repository, "getDefaultBranch")).defaultBranch ?? null
        );
      },
      (effect, input) => effect.pipe(mapError("getDefaultBranch", input.cwd)),
    ),

    checkoutChangeRequest: Effect.fn("OriginSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const repository = yield* cli.resolveRepository(input);
        const { repository: linked, number } = pullReference(input.reference);
        if (linked !== null && linked !== repository.toLowerCase())
          return yield* new OriginCli.OriginCliError({
            operation: "checkoutChangeRequest",
            cwd: input.cwd,
            reason: "not-found",
            detail: `That pull request is in ${linked}, not this checkout's ${repository}.`,
          });
        yield* cli.execute({
          cwd: input.cwd,
          operation: "checkoutChangeRequest",
          args: [
            "pr",
            "checkout",
            number === null ? input.reference : String(number),
            "-R",
            repository,
            "--remote",
            input.context?.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd)),
            ...(input.force ? ["--force"] : []),
          ],
        });
      },
      (effect, input) =>
        effect.pipe(mapError("checkoutChangeRequest", input.cwd, { reference: input.reference })),
    ),
  });
});
