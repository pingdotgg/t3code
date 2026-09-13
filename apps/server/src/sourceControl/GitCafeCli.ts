import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, type ChangeRequest } from "@t3tools/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

export const HOST = "https://git.cafe/api";
export const CLI_ARGS = ["--host", HOST, "--no-input", "--no-update-check"];

export class GitCafeCliError extends Schema.TaggedError<GitCafeCliError>()("GitCafeCliError", {
  command: Schema.Literal("cafe"),
  cwd: Schema.String,
  code: Schema.String,
  status: Schema.NullOr(Schema.Finite),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const Failure = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    status: Schema.NullOr(Schema.Finite),
  }),
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFailureEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(Failure));

/** Raw API errors put the problem body before the Cafe error envelope on stderr. */
export function decodeFailure(raw: string) {
  const decoded = decodeFailureEnvelope(raw.trim());
  if (Result.isSuccess(decoded)) return decoded;
  for (const line of raw.split(/\r?\n/u).toReversed()) {
    const envelope = decodeFailureEnvelope(line.trim());
    if (Result.isSuccess(envelope)) return envelope;
  }
  return decoded;
}
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
  updatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
});
const PullDetail = Schema.Struct({
  ...Pull.fields,
  isCrossFork: Schema.Boolean,
  sourceRepo: Schema.NullOr(
    Schema.Struct({ owner: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  ),
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
});

type Provider = SourceControlProvider.SourceControlProvider["Service"];
type Operations = {
  readonly [K in Exclude<keyof Provider, "kind">]: (
    input: Parameters<Provider[K]>[0],
  ) => Effect.Effect<Effect.Success<ReturnType<Provider[K]>>, GitCafeCliError>;
};

export class GitCafeCli extends Context.Service<
  GitCafeCli,
  Operations & {
    readonly execute: (input: {
      readonly cwd: string;
      readonly host?: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitCafeCliError>;
    /** Raw API responses have no Cafe success envelope. Payloads travel on stdin. */
    readonly api: (input: {
      readonly cwd: string;
      readonly host?: string;
      readonly endpoint: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<string, GitCafeCliError>;
  }
>()("t3/sourceControl/GitCafeCli") {}

function repositoryLocator(value: string, defaultHost = "git.cafe") {
  const match = /^(?:https:\/\/|(?:ssh:\/\/)?[^@/]+@)(git\.cafe|staging\.git\.cafe)[/:](.+)$/u.exec(
    value.trim(),
  );
  const host = match?.[1] ?? defaultHost;
  const repository = (match?.[2] ?? value.trim()).replace(/\.git\/?$/u, "").replace(/\/$/u, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ? { repository, host } : null;
}
function cloneUrls(repo: { readonly owner: string; readonly name: string }, host: string) {
  const nameWithOwner = `${repo.owner}/${repo.name}`;
  return {
    nameWithOwner,
    url: `https://${host}/${nameWithOwner}`,
    sshUrl: `ssh@${host}:${nameWithOwner}.git`,
  };
}
function normalizePull(
  pull: typeof PullDetail.Type,
  repository: string,
  host: string,
): ChangeRequest {
  return {
    provider: "gitcafe",
    number: pull.number,
    title: pull.title,
    url: `https://${host}/${repository}/pulls/${pull.number}`,
    baseRefName: pull.targetBranch,
    headRefName: pull.sourceBranch,
    state: pull.state,
    ...(pull.draft ? { isDraft: true } : {}),
    closedAt: pull.closedAt,
    mergedAt: pull.mergedAt,
    updatedAt: pull.updatedAt,
    isCrossRepository: pull.isCrossFork,
    headRepositoryNameWithOwner: pull.sourceRepo
      ? `${pull.sourceRepo.owner}/${pull.sourceRepo.name}`
      : pull.isCrossFork
        ? null
        : repository,
    headRepositoryOwnerLogin:
      pull.sourceRepo?.owner ?? (pull.isCrossFork ? null : (repository.split("/")[0] ?? null)),
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const error = (cwd: string, detail: string, cause?: unknown) =>
    new GitCafeCliError({
      command: "cafe",
      cwd,
      code: "COMMAND_FAILED",
      status: null,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const execute: GitCafeCli["Service"]["execute"] = Effect.fn("GitCafeCli.execute")(
    function* (input) {
      const host = input.host ?? "git.cafe";
      if (host !== "git.cafe" && host !== "staging.git.cafe")
        return yield* error(input.cwd, "Unsupported GitCafe host.");
      const output = yield* process
        .run({
          operation: "GitCafeCli.execute",
          command: "cafe",
          cwd: input.cwd,
          args: ["--host", `https://${host}/api`, "--no-input", "--no-update-check", ...input.args],
          env: { CAFE_OUTPUT: "json" },
          allowNonZeroExit: true,
          timeoutMs: input.timeoutMs ?? 30_000,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
        })
        .pipe(
          Effect.mapError((cause) => {
            if (cause._tag === "VcsProcessTimeoutError") {
              return new GitCafeCliError({
                command: "cafe",
                cwd: input.cwd,
                status: null,
                cause,
                code: "TIMEOUT",
                detail: `GitCafe CLI timed out after ${cause.timeoutMs / 1_000} seconds. Check the connection and try refreshing.`,
              });
            }
            const missing =
              cause._tag === "VcsProcessSpawnError" &&
              cause.cause instanceof PlatformError.PlatformError &&
              cause.cause.reason._tag === "NotFound" &&
              cause.cause.reason.module === "ChildProcess" &&
              cause.cause.reason.method === "spawn";
            return new GitCafeCliError({
              command: "cafe",
              cwd: input.cwd,
              status: null,
              cause,
              code: missing ? "CLI_UNAVAILABLE" : "COMMAND_FAILED",
              detail: missing
                ? "GitCafe CLI (`cafe`) is required but not available on PATH."
                : "GitCafe CLI command failed.",
            });
          }),
        );
      if (output.exitCode !== 0) {
        for (const raw of [output.stderr, output.stdout]) {
          const decoded = decodeFailure(raw.trim());
          if (Result.isSuccess(decoded)) {
            return yield* new GitCafeCliError({
              command: "cafe",
              cwd: input.cwd,
              code: decoded.success.error.code,
              status: decoded.success.error.status,
              detail: decoded.success.error.message,
            });
          }
        }
        return yield* error(input.cwd, "GitCafe CLI command failed without a structured error.");
      }
      return output;
    },
  );
  const api: GitCafeCli["Service"]["api"] = Effect.fn("GitCafeCli.api")(function* (input) {
    const stdin =
      input.body === undefined
        ? undefined
        : yield* encodeJson(input.body).pipe(
            Effect.mapError((cause) => error(input.cwd, "Invalid GitCafe request body.", cause)),
          );
    const result = yield* execute({
      cwd: input.cwd,
      ...(input.host === undefined ? {} : { host: input.host }),
      args: [
        "api",
        input.endpoint,
        "--method",
        input.method ?? "GET",
        ...(stdin === undefined ? [] : ["--input", "-"]),
        ...Object.entries(input.headers ?? {}).flatMap(([name, value]) => [
          "--header",
          `${name}:${value}`,
        ]),
      ],
      ...(stdin === undefined ? {} : { stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });
    return result.stdout;
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    cwd: string,
    raw: string,
    schema: S,
  ) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
      Effect.mapError((cause) => error(cwd, "GitCafe returned invalid JSON.", cause)),
    );
  const resolveRepository = Effect.fn("GitCafeCli.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    if (input.repository !== undefined) {
      const slug = repositoryLocator(
        input.repository,
        input.context ? repositoryLocator(input.context.remoteUrl)?.host : undefined,
      );
      if (slug) return slug;
      return yield* error(
        input.cwd,
        "GitCafe repository must be owner/name or a git.cafe repository URL.",
      );
    }
    if (input.context) {
      const slug = repositoryLocator(input.context.remoteUrl);
      if (input.context.provider.kind === "gitcafe" && slug) return slug;
      return yield* error(input.cwd, "The selected remote is not a public GitCafe repository.");
    }
    const remote = yield* git
      .resolvePrimaryRemoteName(input.cwd)
      .pipe(
        Effect.mapError((cause) => error(input.cwd, "Could not resolve GitCafe remote.", cause)),
      );
    const url = yield* git
      .readConfigValue(input.cwd, `remote.${remote}.url`)
      .pipe(Effect.mapError((cause) => error(input.cwd, "Could not read GitCafe remote.", cause)));
    const slug = url ? repositoryLocator(url) : null;
    if (slug) return slug;
    return yield* error(input.cwd, "No public GitCafe repository remote was found.");
  });
  const pullTarget = Effect.fn("GitCafeCli.pullTarget")(function* (
    input: Parameters<Operations["getChangeRequest"]>[0],
  ) {
    const match =
      /^https:\/\/(git\.cafe|staging\.git\.cafe)\/([^/]+\/[^/]+)\/pulls\/(\d+)\/?(?:[?#].*)?$/u.exec(
        input.reference.trim(),
      );
    if (match?.[1] && match[2] && match[3])
      return { host: match[1], repository: match[2], number: match[3] };
    if (!/^[1-9]\d*$/u.test(input.reference.trim()))
      return yield* error(
        input.cwd,
        "GitCafe pull request must be a positive number or a git.cafe PR URL.",
      );
    return { ...(yield* resolveRepository(input)), number: input.reference.trim() };
  });
  const getChangeRequest: Operations["getChangeRequest"] = Effect.fn("GitCafeCli.getChangeRequest")(
    function* (input) {
      const target = yield* pullTarget(input);
      const raw = yield* api({
        cwd: input.cwd,
        host: target.host,
        endpoint: `/repos/${target.repository}/pulls/${target.number}`,
      });
      const data = yield* decode(input.cwd, raw, PullDetail);
      return normalizePull(data, target.repository, target.host);
    },
  );
  return GitCafeCli.of({
    execute,
    api,
    getChangeRequest,
    getRepositoryCloneUrls: Effect.fn("GitCafeCli.getRepositoryCloneUrls")(function* (input) {
      const { repository, host } = yield* resolveRepository(input);
      const raw = yield* api({ cwd: input.cwd, host, endpoint: `/repos/${repository}` });
      return cloneUrls(
        {
          ...(yield* decode(input.cwd, raw, Repository)),
          owner: repository.slice(0, repository.indexOf("/")),
        },
        host,
      );
    }),
    createRepository: Effect.fn("GitCafeCli.createRepository")(function* (input) {
      const { repository, host } = yield* resolveRepository(input);
      const owner = repository.slice(0, repository.indexOf("/"));
      const name = repository.slice(repository.indexOf("/") + 1);
      const output = yield* execute({
        cwd: input.cwd,
        host,
        args: ["repo", "create", name, "--org", owner, "--visibility", input.visibility, "--json"],
      });
      const {
        data: { resource },
      } = yield* decode(
        input.cwd,
        output.stdout,
        Schema.Struct({
          schemaVersion: Schema.Literal(1),
          data: Schema.Struct({
            resource: Schema.Struct({
              repoId: TrimmedNonEmptyString,
              state: Schema.Literals([
                "pending",
                "running",
                "outcome_unknown",
                "complete",
                "blocked",
              ]),
              owner: TrimmedNonEmptyString,
              name: TrimmedNonEmptyString,
            }),
          }),
        }),
      );
      if (resource.state !== "complete")
        return yield* new GitCafeCliError({
          command: "cafe",
          cwd: input.cwd,
          code: "RECOVERY_REQUIRED",
          status: null,
          detail: `GitCafe repository ${owner}/${name} admission is ${resource.state} (${resource.repoId}). Check it with cafe api /orgs/${owner}/admissions/${resource.repoId} before retrying.`,
        });
      return cloneUrls(resource, host);
    }),
    getDefaultBranch: Effect.fn("GitCafeCli.getDefaultBranch")(function* (input) {
      const { repository, host } = yield* resolveRepository(input);
      const raw = yield* api({ cwd: input.cwd, host, endpoint: `/repos/${repository}` });
      return (yield* decode(input.cwd, raw, Repository)).defaultBranch;
    }),
    listChangeRequests: Effect.fn("GitCafeCli.listChangeRequests")(function* (input) {
      const { repository, host } = yield* resolveRepository(input);
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const query = new URLSearchParams({
        sourceBranches: yield* encodeJson([SourceControlProvider.sourceBranch(input)]).pipe(
          Effect.mapError((cause) => error(input.cwd, "Invalid branch filter.", cause)),
        ),
        limit: String(Math.min(input.limit ?? 20, 100)),
        sort: "newest",
      });
      if (input.state !== "all") query.set("state", input.state);
      const items: Array<ChangeRequest> = [];
      const limit = input.limit ?? 20;
      let after: string | null = null;
      while (items.length < limit) {
        if (after !== null) query.set("after", after);
        const raw = yield* api({
          cwd: input.cwd,
          host,
          endpoint: `/repos/${repository}/pulls?${query}`,
        });
        const data = yield* decode(
          input.cwd,
          raw,
          Schema.Struct({ items: Schema.Array(Pull), nextAfter: Schema.NullOr(Schema.String) }),
        );
        for (const pull of data.items) {
          if (pull.sourceBranch !== SourceControlProvider.sourceBranch(input)) continue;
          // List rows omit fork identity; resolve only branch-matched candidates.
          const normalized = yield* getChangeRequest({
            cwd: input.cwd,
            reference: `https://${host}/${repository}/pulls/${pull.number}`,
          });
          if (
            (!source?.repository || normalized.headRepositoryNameWithOwner === source.repository) &&
            (!source?.owner || normalized.headRepositoryOwnerLogin === source.owner)
          )
            items.push(normalized);
          if (items.length >= limit) break;
        }
        if (data.items.length === 0 || data.nextAfter === null || data.nextAfter === after) break;
        after = data.nextAfter;
      }
      return items.slice(0, limit);
    }),
    createChangeRequest: Effect.fn("GitCafeCli.createChangeRequest")(function* (input) {
      const { repository, host } = yield* resolveRepository({
        ...input,
        ...(input.target?.repository ? { repository: input.target.repository } : {}),
      });
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const sourceRepo =
        source?.repository ??
        (source?.owner ? `${source.owner}/${repository.split("/")[1]}` : repository);
      const branch = SourceControlProvider.sourceBranch(input);
      yield* execute({
        cwd: input.cwd,
        host,
        args: [
          "pr",
          "create",
          "--json",
          "--repo",
          repository,
          "--head",
          sourceRepo === repository ? branch : `${sourceRepo}:${branch}`,
          "--base",
          input.target?.refName ?? input.baseRefName,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      });
    }),
    // Cafe has no --force checkout; reuse the same Git materialization primitives as Bitbucket.
    checkoutChangeRequest: Effect.fn("GitCafeCli.checkoutChangeRequest")(function* (input) {
      const pull = yield* getChangeRequest(input);
      const host = new URL(pull.url).host;
      const sourceRepository = pull.headRepositoryNameWithOwner;
      if (!sourceRepository)
        return yield* error(input.cwd, "GitCafe pull request source repository is unavailable.");
      const remoteName =
        input.context?.provider.kind === "gitcafe" &&
        repositoryLocator(input.context.remoteUrl)?.repository === sourceRepository &&
        repositoryLocator(input.context.remoteUrl)?.host === host
          ? input.context.remoteName
          : yield* git
              .ensureRemote({
                cwd: input.cwd,
                preferredName: "gitcafe",
                url: input.context?.remoteUrl.includes("@")
                  ? `ssh@${host}:${sourceRepository}.git`
                  : `https://${host}/${sourceRepository}.git`,
              })
              .pipe(
                Effect.mapError((cause) =>
                  error(input.cwd, "Could not prepare GitCafe checkout remote.", cause),
                ),
              );
      const localBranch = pull.isCrossRepository
        ? `pr-${pull.number}/${pull.headRefName}`
        : pull.headRefName;
      yield* Effect.gen(function* () {
        const branches = yield* git.listLocalBranchNames(input.cwd);
        if (input.force !== true && !branches.includes(localBranch))
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pull.headRefName,
            localBranch,
          });
        else
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pull.headRefName,
          });
        // `branch --force` cannot move the branch checked out in this worktree.
        // checkout -B handles that case atomically and refuses to overwrite local edits.
        if (input.force === true)
          yield* process.run({
            operation: "GitCafeCli.checkoutChangeRequest",
            command: "git",
            cwd: input.cwd,
            args: [
              "checkout",
              "-B",
              localBranch,
              `refs/remotes/${remoteName}/${pull.headRefName}`,
              "--",
            ],
            timeoutMs: 30_000,
          });
        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch: pull.headRefName,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          error(input.cwd, "Could not check out GitCafe pull request.", cause),
        ),
      );
    }),
  });
});
export const layer = Layer.effect(GitCafeCli, make);
