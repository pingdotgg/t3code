import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import {
  PositiveInt,
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type ChangeRequest,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";

/** Discovery reports the production account; repository operations pick their own host. */
const AUTH_HOST = "git.cafe";
/** `cafe repo create --clone` waits this long, polling at this pace, for admission to settle. */
const ADMISSION_TIMEOUT = "30 seconds";
const ADMISSION_POLL_INTERVAL = "500 millis";
const cliArgs = (host: string) => [
  "--host",
  `https://${host}/api`,
  "--no-input",
  "--no-update-check",
];

const decodeAuth = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      data: Schema.Struct({ host: Schema.String, username: TrimmedNonEmptyString }),
    }),
  ),
);
/** `cafe`'s failure envelope, which it prints on its own line after any raw problem body. */
const decodeFailure = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      error: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        status: Schema.NullOr(Schema.Finite),
      }),
    }),
  ),
);
const cliFailure = (output: string) =>
  [output.trim(), ...output.split(/\r?\n/u).toReversed()]
    .map((line) => decodeFailure(line.trim()))
    .find(Result.isSuccess)?.success.error;

export const discovery = {
  type: "cli",
  kind: "gitcafe",
  label: "GitCafe",
  executable: "cafe",
  versionArgs: ["--version"],
  authArgs: [...cliArgs(AUTH_HOST), "auth", "status", "--json"],
  parseAuth: (input) => {
    const signedIn = decodeAuth(input.stdout.trim());
    if (input.exitCode === 0 && Result.isSuccess(signedIn))
      return providerAuth({
        status: "authenticated",
        host: AUTH_HOST,
        account: signedIn.success.data.username,
      });
    const failure = cliFailure(input.stderr) ?? cliFailure(input.stdout);
    if (failure)
      return providerAuth({
        // Only a refusal says the login is gone; a forbidden or offline answer says nothing.
        status:
          failure.code === "AUTHENTICATION_REQUIRED" || failure.status === 401
            ? "unauthenticated"
            : "unknown",
        host: AUTH_HOST,
        detail: failure.message,
      });
    return providerAuth({
      status: "unknown",
      host: AUTH_HOST,
      detail: `GitCafe authentication status could not be read. Run \`cafe auth login --host https://${AUTH_HOST}/api\`.`,
    });
  },
  installHint: `Install the GitCafe CLI with \`bun install -g @gitcafe/cli\`, then run \`cafe auth login --host https://${AUTH_HOST}/api\`, or set CAFE_TOKEN on the server.`,
} satisfies SourceControlCliDiscoverySpec;

const Repository = Schema.Struct({
  name: TrimmedNonEmptyString,
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
});
const Pull = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  sourceBranch: TrimmedNonEmptyString,
  targetBranch: TrimmedNonEmptyString,
  headOid: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
});
const PullDetail = Schema.Struct({
  ...Pull.fields,
  sourceRepo: Schema.NullOr(
    Schema.Struct({ owner: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  ),
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
});
const Pulls = Schema.Struct({ items: Schema.Array(Pull), next: Schema.NullOr(Schema.String) });
const RepositoryAdmission = Schema.Struct({
  repoId: TrimmedNonEmptyString,
  state: Schema.String,
  owner: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
const CreatedRepository = Schema.Struct({
  data: Schema.Struct({ resource: RepositoryAdmission }),
});
const decodeCreatedRepository = Schema.decodeEffect(Schema.fromJsonString(CreatedRepository));
const encodeBranches = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

interface Target {
  readonly host: GitCafeHosts.GitCafeHost;
  readonly repository: string;
}

const cloneUrls = (target: Target) => ({
  nameWithOwner: target.repository,
  url: `https://${target.host}/${target.repository}`,
  sshUrl: `ssh@${target.host}:${target.repository}.git`,
});

/** An scp-like `user@host:path` or `ssh://` remote; HTTPS remotes may carry userinfo too. */
const isSshRemote = (remoteUrl: string | undefined) =>
  remoteUrl !== undefined && (/^ssh:\/\//iu.test(remoteUrl) || /^[^/:]+@[^/:]+:/u.test(remoteUrl));

const pullUrlPattern = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pulls\/(\d+)\/?(?:[?#].*)?$/u;

export const make = Effect.gen(function* () {
  const api = yield* GitCafeApi.GitCafeApi;
  const host = yield* SourceControlHost.SourceControlHost;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: "gitcafe",
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: Omit<GitCafeApi.GitCafeApiRequest, "operation">,
    schema: S,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "GitCafe returned an unreadable response.", cause),
          ),
        ),
      ),
    );
  const cafe = (operation: string, cwd: string, target: Target, args: ReadonlyArray<string>) =>
    host.process
      .run({
        operation: `GitCafeSourceControlProvider.${operation}`,
        command: "cafe",
        cwd,
        args: [...cliArgs(target.host), ...args],
        env: { CAFE_OUTPUT: "json" },
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.mapError((cause) =>
          error(
            operation,
            cwd,
            (cause._tag === "VcsProcessExitError" && cliFailure(cause.detail)?.message) ||
              "GitCafe CLI command failed.",
            cause,
          ),
        ),
      );

  /** The repository a call names, falling back to the checkout's own GitCafe remote. */
  const resolveTarget = Effect.fn("GitCafeSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    const named =
      input.repository === undefined ? null : GitCafeHosts.parseGitCafeRemote(input.repository);
    if (named) return named;
    // A bare owner/name only asks the checkout which GitCafe host it is on, so a checkout with no
    // remote (a repository being created) still resolves, on git.cafe.
    const readRemote = host.git
      .resolvePrimaryRemoteName(input.cwd)
      .pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
      );
    const remoteUrl =
      input.context?.remoteUrl ??
      (input.repository === undefined
        ? yield* readRemote.pipe(
            Effect.mapError((cause) =>
              error(operation, input.cwd, "Could not read the GitCafe remote.", cause),
            ),
          )
        : yield* readRemote.pipe(Effect.orElseSucceed(() => null)));
    const remote = remoteUrl ? GitCafeHosts.parseGitCafeRemote(remoteUrl) : null;
    if (input.repository === undefined) {
      if (remote) return remote;
      return yield* error(operation, input.cwd, "No GitCafe repository remote was found.");
    }
    // A bare owner/name lives on the checkout's own GitCafe host.
    const repository = GitCafeHosts.gitCafeRepositoryPath(input.repository);
    if (repository !== null)
      return { host: remote?.host ?? AUTH_HOST, repository } satisfies Target;
    return yield* error(
      operation,
      input.cwd,
      "A GitCafe repository is named owner/name or by its git.cafe URL.",
    );
  });

  const getPull = Effect.fn("GitCafeSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const match = pullUrlPattern.exec(input.reference.trim());
    const urlHost = match?.[1] ? GitCafeHosts.gitCafeHost(match[1]) : null;
    const target: Target =
      urlHost && match?.[2]
        ? { host: urlHost, repository: match[2] }
        : yield* resolveTarget("getChangeRequest", input);
    // A pull request URL on another host is not a GitCafe pull request number.
    const number = match
      ? urlHost
        ? match[3]
        : undefined
      : /^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1];
    if (number === undefined)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A GitCafe pull request is a number or a git.cafe pull request URL.",
      );
    const pull = yield* read(
      "getChangeRequest",
      input.cwd,
      { host: target.host, path: `/repos/${target.repository}/pulls/${number}` },
      PullDetail,
    );
    const owner = target.repository.split("/")[0] ?? null;
    return {
      provider: "gitcafe",
      number: pull.number,
      title: pull.title,
      url: `https://${target.host}/${target.repository}/pulls/${pull.number}`,
      baseRefName: pull.targetBranch,
      headRefName: pull.sourceBranch,
      ...(pull.headOid ? { headSha: pull.headOid } : {}),
      state: pull.state,
      ...(pull.draft ? { isDraft: true } : {}),
      closedAt: pull.closedAt,
      mergedAt: pull.mergedAt,
      updatedAt: pull.updatedAt,
      isCrossRepository: pull.sourceRepo !== null,
      headRepositoryNameWithOwner: pull.sourceRepo
        ? `${pull.sourceRepo.owner}/${pull.sourceRepo.name}`
        : target.repository,
      headRepositoryOwnerLogin: pull.sourceRepo?.owner ?? owner,
    } satisfies ChangeRequest;
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitcafe",
    repositoryNameFromRemoteUrl: (url) => GitCafeHosts.parseGitCafeRemote(url)?.repository ?? null,
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("GitCafeSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const items: Array<ChangeRequest> = [];
        let after: string | null = null;
        do {
          const query = new URLSearchParams({
            sourceBranches: encodeBranches([branch]),
            limit: String(Math.min(limit, 100)),
            sort: "newest",
          });
          if (input.state !== "all") query.set("state", input.state);
          if (after !== null) query.set("after", after);
          const page: typeof Pulls.Type = yield* read(
            "listChangeRequests",
            input.cwd,
            { host: target.host, path: `/repos/${target.repository}/pulls?${query}` },
            Pulls,
          );
          for (const pull of page.items) {
            if (pull.sourceBranch !== branch || items.length >= limit) continue;
            // List rows omit fork identity, so only the branch's own rows are read in full.
            const detail = yield* getPull({
              cwd: input.cwd,
              reference: `https://${target.host}/${target.repository}/pulls/${pull.number}`,
            });
            if (
              (!source?.repository || detail.headRepositoryNameWithOwner === source.repository) &&
              (!source?.owner || detail.headRepositoryOwnerLogin === source.owner)
            )
              items.push(detail);
          }
          after = page.items.length === 0 || page.next === after ? null : page.next;
        } while (after !== null && items.length < limit);
        return items;
      },
    ),
    createChangeRequest: Effect.fn("GitCafeSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const sourceRepository =
          source?.repository ??
          (source?.owner
            ? `${source.owner}/${target.repository.split("/")[1]}`
            : target.repository);
        const branch = SourceControlProvider.sourceBranch(input);
        yield* cafe("createChangeRequest", input.cwd, target, [
          "pr",
          "create",
          "--json",
          "--repo",
          target.repository,
          "--head",
          sourceRepository === target.repository ? branch : `${sourceRepository}:${branch}`,
          "--base",
          input.target?.refName ?? input.baseRefName,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ]);
      },
    ),
    getRepositoryCloneUrls: Effect.fn("GitCafeSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        yield* read(
          "getRepositoryCloneUrls",
          input.cwd,
          { host: target.host, path: `/repos/${target.repository}` },
          Repository,
        );
        return cloneUrls(target);
      },
    ),
    createRepository: Effect.fn("GitCafeSourceControlProvider.createRepository")(function* (input) {
      const target = yield* resolveTarget("createRepository", input);
      const [owner = "", name = ""] = target.repository.split("/");
      const output = yield* cafe("createRepository", input.cwd, target, [
        "repo",
        "create",
        name,
        "--org",
        owner,
        "--visibility",
        input.visibility,
        "--json",
      ]);
      const created = yield* decodeCreatedRepository(output.stdout).pipe(
        Effect.mapError((cause) =>
          error("createRepository", input.cwd, "GitCafe returned an unreadable response.", cause),
        ),
      );
      // GitCafe admits a repository asynchronously: `cafe repo create` answers while admission is
      // still running, so wait for it to settle the way `cafe repo create --clone` does.
      const settled = (state: string) => state === "complete" || state === "blocked";
      const pending = created.data.resource;
      const resource = settled(pending.state)
        ? pending
        : yield* read(
            "createRepository",
            input.cwd,
            {
              host: target.host,
              path: `/orgs/${pending.owner}/admissions/${pending.repoId}`,
            },
            RepositoryAdmission,
          ).pipe(
            Effect.repeat({
              until: (admission) => settled(admission.state),
              schedule: Schedule.spaced(ADMISSION_POLL_INTERVAL),
            }),
            Effect.timeoutOption(ADMISSION_TIMEOUT),
            Effect.map(Option.getOrElse(() => pending)),
          );
      // Anything short of complete is not yet usable.
      if (resource.state !== "complete")
        return yield* error(
          "createRepository",
          input.cwd,
          `GitCafe repository ${target.repository} is ${resource.state}. Check it on GitCafe before retrying.`,
        );
      return cloneUrls({ host: target.host, repository: `${resource.owner}/${resource.name}` });
    }),
    getDefaultBranch: Effect.fn("GitCafeSourceControlProvider.getDefaultBranch")(function* (input) {
      const target = yield* resolveTarget("getDefaultBranch", input);
      const repository = yield* read(
        "getDefaultBranch",
        input.cwd,
        { host: target.host, path: `/repos/${target.repository}` },
        Repository,
      );
      return repository.defaultBranch;
    }),
    // `cafe` has no forced checkout, so the branch is fetched and switched to with git.
    checkoutChangeRequest: Effect.fn("GitCafeSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const pullHost = new URL(pull.url).host;
        const sourceRepository = pull.headRepositoryNameWithOwner;
        if (!sourceRepository)
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "GitCafe did not name the pull request's source repository.",
          );
        const contextRemote = input.context
          ? GitCafeHosts.parseGitCafeRemote(input.context.remoteUrl)
          : null;
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context &&
            contextRemote?.repository === sourceRepository &&
            contextRemote.host === pullHost
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "gitcafe",
                  // SSH only when the checkout already reaches GitCafe over SSH; HTTPS otherwise.
                  url: isSshRemote(input.context?.remoteUrl)
                    ? `ssh@${pullHost}:${sourceRepository}.git`
                    : `https://${pullHost}/${sourceRepository}.git`,
                });
          const localBranch = pull.isCrossRepository
            ? `pr-${pull.number}/${pull.headRefName}`
            : pull.headRefName;
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: pull.headRefName };
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          // `checkout -B` moves even the checked-out branch, and refuses to overwrite local edits.
          if (input.force === true)
            yield* git.execute({
              operation: "GitCafeSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${pull.headRefName}`,
                "--",
              ],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out the GitCafe pull request.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
