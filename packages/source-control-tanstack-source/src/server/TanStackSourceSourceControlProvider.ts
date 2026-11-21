import {
  requireSettingsSecretLiteral,
  SourceControlProviderError,
  type ChangeRequest,
  type SourceControlProviderAuth,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isMissingExecutable,
  providerAuth,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as TanStackSource from "../shared/definition.ts";
import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import { parseTanStackSourceAuthStatus } from "./tanStackSourceAuthStatus.ts";
import * as TanStackSourceCredentials from "./TanStackSourceCredentials.ts";
import * as Hosts from "./tanStackSourceHosts.ts";
import * as Json from "./tanStackSourceJson.ts";

const HOST = TanStackSource.TANSTACK_SOURCE_HOST;
/** Pull requests from one branch name, across forks, read in full when looking one up. */
const MAX_BRANCH_MATCHES = 20;
const LABEL = "TanStack Source";
const LOGIN = `src auth login --web --hostname ${HOST}`;

const INSTALL_HINT = `Install the TanStack Source CLI with \`curl -fsSL https://${HOST}/install | sh\`, then run \`${LOGIN}\`, save a token in Settings, or set SRC_TOKEN on the server.`;

/** The account a request would use: SRC_TOKEN, else the one picked in Settings, else the active one. */
export function effectiveAccount(
  accounts: ReturnType<typeof parseTanStackSourceAuthStatus>,
  choice: string | undefined,
) {
  const usable = accounts.filter((entry) => entry.host === HOST && entry.authenticated);
  return (
    usable.find((entry) => entry.environmentVariable !== null) ??
    (choice === undefined ? undefined : usable.find((entry) => entry.account === choice)) ??
    usable.find((entry) => entry.active) ??
    usable[0]
  );
}

const decodeUser = Schema.decodeEffect(Schema.fromJsonString(Json.SourceUser));

const authAccounts = (accounts: ReturnType<typeof parseTanStackSourceAuthStatus>) =>
  accounts
    .filter((entry) => entry.account !== "")
    .map((entry) => ({
      host: entry.host,
      account: entry.account,
      active: entry.active,
      authenticated: entry.authenticated,
      ...(entry.error === null ? {} : { error: entry.error }),
      ...(entry.environmentVariable === null
        ? {}
        : { environmentVariable: entry.environmentVariable }),
    }));

/**
 * `src` has no version flag, so its sign-in status is the only probe. A saved token or SRC_TOKEN
 * is checked against the API, since the CLI knows nothing of the first.
 */
export const makeDiscovery = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const api = yield* TanStackSourceApi.TanStackSourceApi;
  const environment = yield* HostProcess.Environment;

  const viewer = api.request({ host: HOST, operation: "discovery", path: "/user" }).pipe(
    Effect.flatMap((raw) =>
      decodeUser(raw).pipe(
        Effect.mapError(
          (cause) =>
            new TanStackSourceApi.TanStackSourceApiError({
              host: HOST,
              operation: "discovery",
              status: null,
              reason: "failed",
              detail: "TanStack Source returned an unreadable account.",
              cause,
            }),
        ),
      ),
    ),
    Effect.result,
  );

  const probe = Effect.fn("TanStackSourceSourceControlProvider.discovery")(function* (cwd: string) {
    const current = yield* sourceControlHost.settings
      .getWithSecrets(TanStackSource.definition.kind)
      .pipe(Effect.orElseSucceed(() => undefined));
    const settings = readSourceControlHostSettings(
      TanStackSource.settings,
      current?.sourceControlHosts[TanStackSource.definition.kind],
    );
    const status = yield* sourceControlHost.process
      .run({
        operation: "source-control.discovery.auth",
        command: "src",
        args: ["auth", "status"],
        cwd,
        env: { SRC_NO_TELEMETRY: "1" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      })
      .pipe(Effect.result);
    const installed = Result.isSuccess(status) || !isMissingExecutable(status.failure);
    const accounts = Result.isSuccess(status)
      ? parseTanStackSourceAuthStatus(`${status.success.stdout}\n${status.success.stderr}`)
      : [];
    const item = (fields: {
      readonly auth: SourceControlProviderAuth;
      readonly available: boolean;
    }): SourceControlProviderDiscoveryItem => ({
      kind: TanStackSource.definition.kind,
      label: LABEL,
      executable: "src",
      status: fields.available ? "available" : "missing",
      version: Option.none(),
      installHint: INSTALL_HINT,
      detail: Option.none(),
      auth:
        accounts.length === 0 ? fields.auth : { ...fields.auth, accounts: authAccounts(accounts) },
    });

    if (settings.hosts[HOST]?.enabled === false)
      return item({
        available: installed,
        auth: providerAuth({
          status: "unauthenticated",
          host: HOST,
          detail: `${HOST} is turned off in Settings → Source control & issues.`,
        }),
      });

    const saved = yield* Effect.result(
      requireSettingsSecretLiteral(settings.tokens[HOST], current?.secretProviders ?? {}),
    );
    if (Result.isFailure(saved))
      return item({
        available: true,
        auth: providerAuth({
          status: "unauthenticated",
          host: HOST,
          detail: saved.failure.message,
        }),
      });
    const savedToken = saved.success.trim() !== "";
    const envToken = TanStackSourceCredentials.environmentToken(HOST, environment) !== null;
    if (savedToken || envToken) {
      const tokenSource = savedToken ? "the token saved in Settings" : "SRC_TOKEN";
      const answer = yield* viewer;
      return item({
        available: true,
        auth: Result.isSuccess(answer)
          ? providerAuth({
              status: "authenticated",
              host: HOST,
              account: answer.success.username,
              detail: savedToken
                ? "Using the token saved in Settings; it overrides SRC_TOKEN and the src login."
                : "Using SRC_TOKEN from the server environment; it overrides the account chosen in Settings.",
            })
          : answer.failure.reason === "unauthenticated"
            ? providerAuth({
                status: "unauthenticated",
                host: HOST,
                detail: savedToken
                  ? "TanStack Source refused the token saved in Settings. Replace or remove it in Settings → Source control & issues."
                  : "TanStack Source refused the token in SRC_TOKEN. Replace it, or unset it to use `src auth login`.",
              })
            : providerAuth({
                status: "unknown",
                host: HOST,
                detail: `Could not check ${tokenSource}: ${answer.failure.detail}`,
              }),
      });
    }

    if (!installed)
      return item({
        available: false,
        auth: providerAuth({ status: "unknown", detail: INSTALL_HINT }),
      });
    const chosen = effectiveAccount(accounts, settings.hosts[HOST]?.account);
    if (chosen !== undefined)
      return item({
        available: true,
        auth: providerAuth({ status: "authenticated", host: HOST, account: chosen.account }),
      });
    const failed = accounts.find((entry) => entry.host === HOST);
    return item({
      available: true,
      auth: providerAuth({
        status: Result.isSuccess(status) ? "unauthenticated" : "unknown",
        host: HOST,
        detail: failed?.error ?? `Run \`${LOGIN}\` to sign the src CLI in.`,
      }),
    });
  });

  return {
    type: "managed-cli",
    kind: TanStackSource.definition.kind,
    label: LABEL,
    installHint: INSTALL_HINT,
    probe,
    // Source's remotes are recognized by host alone, so an unknown remote is never one.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

const Repository = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  cloneUrl: Schema.String,
});

interface Target {
  readonly host: Hosts.TanStackSourceHost;
  readonly repository: string;
}

const cloneUrls = (target: Target, cloneUrl?: string) => {
  const url = cloneUrl ?? `${Hosts.webRepositoryUrl(target.host, target.repository)}.git`;
  // Source serves git over HTTPS only.
  return { nameWithOwner: target.repository, url, sshUrl: url };
};

export const make = Effect.gen(function* () {
  const api = yield* TanStackSourceApi.TanStackSourceApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: TanStackSource.definition.kind,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: Omit<TanStackSourceApi.TanStackSourceApiRequest, "operation">,
    schema: S,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "TanStack Source returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const resolveTarget = Effect.fn("TanStackSourceSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    const named =
      input.repository === undefined ? null : Hosts.parseTanStackSourceRemote(input.repository);
    if (named) return named;
    if (input.repository !== undefined) {
      const repository = Hosts.tanStackSourceRepositoryPath(input.repository);
      if (repository !== null) return { host: HOST, repository } satisfies Target;
      return yield* error(
        operation,
        input.cwd,
        "A TanStack Source repository is named owner/name or by its source.tanstack.com URL.",
      );
    }
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
        Effect.mapError((cause) =>
          error(operation, input.cwd, "Could not read the TanStack Source remote.", cause),
        ),
      ));
    const remote = remoteUrl ? Hosts.parseTanStackSourceRemote(remoteUrl) : null;
    if (remote) return remote;
    return yield* error(operation, input.cwd, "No TanStack Source repository remote was found.");
  });

  const toChangeRequest = (target: Target, pull: Json.SourcePullDetail): ChangeRequest => {
    const headRepository = pull.headRepo ?? target.repository;
    const headBranch = Json.headBranchName(pull.head);
    // A pull request synced from a GitHub fork names its head only by its pull ref.
    const crossRepository =
      headRepository.toLowerCase() !== target.repository.toLowerCase() ||
      headBranch.startsWith("refs/");
    const updatedAt = pull.mergedAt ?? pull.createdAt;
    return {
      provider: TanStackSource.definition.kind,
      number: pull.number,
      title: pull.title,
      url: Json.pullUrl(target.host, target.repository, pull.number),
      baseRefName: pull.base,
      headRefName: headBranch,
      ...(pull.headSha ? { headSha: pull.headSha } : {}),
      state: pull.state,
      ...(pull.draft ? { isDraft: true } : {}),
      mergedAt: pull.mergedAt === null ? null : Json.iso(pull.mergedAt),
      updatedAt: Option.some(DateTime.makeUnsafe(updatedAt)),
      isCrossRepository: crossRepository,
      headRepositoryNameWithOwner: headRepository,
      headRepositoryOwnerLogin: headRepository.split("/")[0] ?? null,
    };
  };

  const readPull = (operation: string, cwd: string, target: Target, number: number) =>
    read(
      operation,
      cwd,
      { host: target.host, path: `/repos/${target.repository}/pulls/${number}` },
      Json.SourcePullDetail,
    ).pipe(Effect.map((pull) => toChangeRequest(target, pull)));

  const getPull = Effect.fn("TanStackSourceSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const link = TanStackSource.parsePullRequestUrl(input.reference.trim());
    const target: Target = link
      ? { host: HOST, repository: link.repository }
      : yield* resolveTarget("getChangeRequest", input);
    const number = link ? link.number : Number(/^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1]);
    if (!Number.isSafeInteger(number) || number < 1)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A TanStack Source pull request is a number or a source.tanstack.com pull request URL.",
      );
    return yield* readPull("getChangeRequest", input.cwd, target, number);
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: TanStackSource.definition.kind,
    repositoryNameFromRemoteUrl: (url) => Hosts.parseTanStackSourceRemote(url)?.repository ?? null,
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("TanStackSourceSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const query = new URLSearchParams({ head: branch });
        if (input.state !== "all") query.set("state", input.state);
        const page = yield* read(
          "listChangeRequests",
          input.cwd,
          { host: target.host, path: `/repos/${target.repository}/pulls?${query}` },
          Json.SourcePulls,
        );
        // List rows name neither the base nor the head's repository, so matches are read in full
        // and the limit counts only those whose head is the one asked for.
        const matches = page.items
          .filter((pull) => Json.headBranchName(pull.head) === branch)
          .slice(0, MAX_BRANCH_MATCHES);
        const details = yield* Effect.forEach(
          matches,
          (pull) => readPull("listChangeRequests", input.cwd, target, pull.number),
          { concurrency: 4 },
        );
        const owned = details.filter(
          (detail) =>
            (!source?.repository ||
              detail.headRepositoryNameWithOwner?.toLowerCase() ===
                source.repository.toLowerCase()) &&
            (!source?.owner ||
              detail.headRepositoryOwnerLogin?.toLowerCase() === source.owner.toLowerCase()),
        );
        return owned.slice(0, limit);
      },
    ),
    createsDraftChangeRequests: true,
    createChangeRequest: Effect.fn("TanStackSourceSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (
          (source?.repository &&
            source.repository.toLowerCase() !== target.repository.toLowerCase()) ||
          (source?.owner &&
            source.owner.toLowerCase() !== target.repository.split("/")[0]?.toLowerCase())
        )
          return yield* error(
            "createChangeRequest",
            input.cwd,
            "TanStack Source opens pull requests from a branch of the same repository. Push the branch there first.",
          );
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the pull request description.",
                cause,
              ),
            ),
          );
        yield* api
          .request({
            host: target.host,
            operation: "createChangeRequest",
            method: "POST",
            path: `/repos/${target.repository}/pulls`,
            body: {
              title: input.title,
              head: SourceControlProvider.sourceBranch(input),
              base: input.target?.refName ?? input.baseRefName,
              ...(body.trim().length === 0 ? {} : { body }),
              ...(input.draft === true ? { draft: true } : {}),
            },
          })
          .pipe(
            Effect.mapError((cause) =>
              error("createChangeRequest", input.cwd, cause.detail, cause),
            ),
          );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("TanStackSourceSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        const repository = yield* read(
          "getRepositoryCloneUrls",
          input.cwd,
          { host: target.host, path: `/repos/${target.repository}` },
          Repository,
        );
        return cloneUrls(
          { host: target.host, repository: `${repository.owner}/${repository.name}` },
          repository.cloneUrl,
        );
      },
    ),
    createRepository: Effect.fn("TanStackSourceSourceControlProvider.createRepository")(
      function* (input) {
        const target = yield* resolveTarget("createRepository", input);
        const [owner, name] = target.repository.split("/");
        const created = yield* read(
          "createRepository",
          input.cwd,
          {
            host: target.host,
            method: "POST",
            path: "/repos",
            body: { name, owner, visibility: input.visibility },
          },
          Repository,
        );
        return cloneUrls(
          { host: target.host, repository: `${created.owner}/${created.name}` },
          created.cloneUrl,
        );
      },
    ),
    getDefaultBranch: Effect.fn("TanStackSourceSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const target = yield* resolveTarget("getDefaultBranch", input);
        const repository = yield* read(
          "getDefaultBranch",
          input.cwd,
          { host: target.host, path: `/repos/${target.repository}` },
          Repository,
        );
        return repository.defaultBranch;
      },
    ),
    // Every pull request's head is published as `refs/pull/<n>/head`, forks and GitHub sync too.
    checkoutChangeRequest: Effect.fn("TanStackSourceSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const target = yield* resolveTarget("checkoutChangeRequest", input).pipe(
          Effect.orElseSucceed(() => null),
        );
        const pullRepository = Hosts.tanStackSourceRepositoryPath(
          new URL(pull.url).pathname.split("/pull/")[0] ?? "",
        );
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context &&
            target !== null &&
            pullRepository !== null &&
            target.repository.toLowerCase() === pullRepository.toLowerCase()
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "source",
                  url: `${Hosts.webRepositoryUrl(HOST, pullRepository ?? "")}.git`,
                });
          const operation = "TanStackSourceSourceControlProvider.checkoutChangeRequest";
          const branches = yield* git.listLocalBranchNames(input.cwd);
          if (!pull.isCrossRepository) {
            const localBranch = pull.headRefName;
            const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: localBranch };
            if (input.force !== true && !branches.includes(localBranch))
              yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
            else yield* git.fetchRemoteTrackingBranch(remoteBranch);
            if (input.force === true)
              yield* git.execute({
                operation,
                cwd: input.cwd,
                // The upstream is recorded next, through the host's serialized config write.
                args: [
                  "checkout",
                  "--no-track",
                  "-B",
                  localBranch,
                  `refs/remotes/${remoteName}/${localBranch}`,
                  "--",
                ],
              });
            yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
            yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
            return;
          }
          // A fork's head, or one synced from GitHub, is only reachable through its pull ref.
          const localBranch = `pr-${pull.number}`;
          const tracking = `refs/remotes/${remoteName}/pull/${pull.number}`;
          yield* git.execute({
            operation,
            cwd: input.cwd,
            args: ["fetch", "--no-tags", remoteName, `+refs/pull/${pull.number}/head:${tracking}`],
          });
          const exists = branches.includes(localBranch);
          // T3 records which pull request it made `pr-<n>` for, and reuses only that branch, and
          // only while it holds nothing the pull request lacks: an unrelated branch of the name,
          // or local commits, are never switched to, moved or lost.
          const ownerKey = `branch.${localBranch}.t3TanstackSourcePull`;
          const owner = `${pullRepository ?? ""}#${pull.number}`;
          if (exists && input.force !== true) {
            const recorded = yield* git
              .readConfigValue(input.cwd, ownerKey)
              .pipe(Effect.orElseSucceed(() => null));
            const behind =
              recorded === owner &&
              (yield* git
                .execute({
                  operation,
                  cwd: input.cwd,
                  args: ["merge-base", "--is-ancestor", `refs/heads/${localBranch}`, tracking],
                })
                .pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ));
            if (!behind)
              return yield* error(
                "checkoutChangeRequest",
                input.cwd,
                recorded === owner
                  ? `Local branch ${localBranch} has commits pull request #${pull.number} does not. Rename it, or check out with force to replace it.`
                  : `Local branch ${localBranch} was not made for pull request #${pull.number}. Rename it, or check out with force to replace it.`,
              );
          }
          if (exists)
            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["checkout", "--no-track", "-B", localBranch, tracking, "--"],
            });
          else
            yield* git.createBranch({ cwd: input.cwd, branch: localBranch, startPoint: tracking });
          yield* git.writeConfigValue({ cwd: input.cwd, key: ownerKey, value: owner });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "SourceControlProviderError"
              ? cause
              : error(
                  "checkoutChangeRequest",
                  input.cwd,
                  "Could not check out the TanStack Source pull request.",
                  cause,
                ),
          ),
        );
      },
    ),
  });
});
