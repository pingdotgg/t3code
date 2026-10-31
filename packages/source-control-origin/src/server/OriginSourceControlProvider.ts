import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { parsePullRequestUrl } from "../shared/definition.ts";

import * as OriginApi from "./OriginApi.ts";
import * as OriginCredentials from "./OriginCredentials.ts";
import * as OriginHosts from "./originHosts.ts";
import * as Json from "./originPullRequestJson.ts";

const AUTH_HOST = OriginHosts.ORIGIN_REMOTE_HOST;
const MIRROR_MESSAGE =
  "This Origin repository is a mirrored GitHub repository. Use the GitHub remote and GitHub provider for pull requests and repository changes.";

const decodeAuth = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      authenticated: Schema.Boolean,
      tokenValid: Schema.optional(Schema.Boolean),
      authMethod: Schema.optional(Schema.String),
      account: Schema.optional(
        Schema.Struct({
          email: Schema.optional(Schema.String),
          publicUserId: Schema.optional(Schema.String),
          userId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
        }),
      ),
      reason: Schema.optional(Schema.String),
    }),
  ),
);

const cliDiscovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("origin"),
  label: "Origin",
  executable: "origin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "authenticated,account,authMethod,tokenValid"],
  parseAuth: (input) => {
    const status = decodeAuth(input.stdout.trim());
    if (input.exitCode === 0 && Result.isSuccess(status) && status.success.authenticated) {
      const account =
        status.success.account?.email?.trim() ||
        status.success.account?.publicUserId?.trim() ||
        undefined;
      return providerAuth({
        status: "authenticated",
        host: AUTH_HOST,
        ...(account ? { account } : {}),
      });
    }
    if (
      Result.isSuccess(status) &&
      (!status.success.authenticated || status.success.tokenValid === false)
    )
      return providerAuth({
        status: "unauthenticated",
        host: AUTH_HOST,
        detail: status.success.reason ?? "Origin is not signed in.",
      });
    return providerAuth({
      status: "unknown",
      host: AUTH_HOST,
      detail:
        "Origin authentication status could not be read. Run `origin auth login`, or set CURSOR_AUTH_TOKEN / CURSOR_API_KEY.",
    });
  },
  installHint:
    "Install the Origin CLI with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then run `origin auth login`, save a Cursor API key in Settings, or set CURSOR_AUTH_TOKEN / CURSOR_API_KEY on the server.",
} satisfies SourceControlCliDiscoverySpec;

export const parseAuth = cliDiscovery.parseAuth;

export const makeDiscovery = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const credentials = yield* OriginCredentials.OriginCredentials;
  return {
    type: "managed-cli",
    kind: cliDiscovery.kind,
    label: cliDiscovery.label,
    installHint: cliDiscovery.installHint,
    probe: (cwd: string) =>
      credentials.cliEnv().pipe(
        Effect.flatMap((env) =>
          probeSourceControlProvider({
            cwd,
            spec: cliDiscovery,
            process: { run: (input) => process.run({ ...input, env: { ...input.env, ...env } }) },
          }),
        ),
      ),
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

interface Target {
  readonly repository: string;
}

const cloneUrls = (repository: string, cloneUrl?: string) => ({
  nameWithOwner: repository,
  url: cloneUrl ?? `https://${AUTH_HOST}/${repository}.git`,
  sshUrl: `git@${AUTH_HOST}:${repository}.git`,
});

const isSshRemote = (remoteUrl: string | undefined) =>
  remoteUrl !== undefined && (/^ssh:\/\//iu.test(remoteUrl) || /^[^/:]+@[^/:]+:/u.test(remoteUrl));

export const make = Effect.gen(function* () {
  const api = yield* OriginApi.OriginApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: SourceControlProviderKind.make("origin"),
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: Omit<OriginApi.OriginApiRequest, "operation">,
    schema: S,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "Origin returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const resolveTarget = Effect.fn("OriginSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    const named =
      input.repository === undefined ? null : OriginHosts.parseOriginRemote(input.repository);
    if (named) return named;
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
              error(operation, input.cwd, "Could not read the Origin remote.", cause),
            ),
          )
        : yield* readRemote.pipe(Effect.orElseSucceed(() => null)));
    const remote = remoteUrl ? OriginHosts.parseOriginRemote(remoteUrl) : null;
    if (input.repository === undefined) {
      if (remote) return remote;
      return yield* error(operation, input.cwd, "No Origin repository remote was found.");
    }
    const repository = OriginHosts.originRepositoryPath(input.repository);
    if (repository !== null) return { repository } satisfies Target;
    return yield* error(
      operation,
      input.cwd,
      "An Origin repository is named owner/name or by its origin.cursor.com URL.",
    );
  });

  const requireNative = Effect.fn("OriginSourceControlProvider.requireNative")(function* (
    operation: string,
    cwd: string,
    repository: string,
  ) {
    return yield* read(operation, cwd, { path: `/repos/${repository}` }, Json.OriginRepo).pipe(
      Effect.filterOrFail(
        (repo) => repo.mirror == null,
        () => error(operation, cwd, MIRROR_MESSAGE),
      ),
    );
  });

  const decodeUpdatedAt = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);
  const asChangeRequest = (pull: Json.OriginPull, repository: string): ChangeRequest => ({
    provider: SourceControlProviderKind.make("origin"),
    number: pull.number,
    title: pull.title,
    url: Json.changeRequestUrl(repository, pull.number, pull.webUrl),
    baseRefName: OriginHosts.shortBranchName(pull.base.ref),
    headRefName: OriginHosts.shortBranchName(pull.head.ref),
    headSha: pull.head.sha,
    state: Json.pullState(pull),
    ...(pull.draft ? { isDraft: true } : {}),
    closedAt: pull.closedAt ?? null,
    mergedAt: pull.mergedAt ?? null,
    updatedAt: decodeUpdatedAt(pull.updatedAt),
    isCrossRepository: false,
    headRepositoryNameWithOwner: repository,
    headRepositoryOwnerLogin: repository.split("/")[0] ?? null,
  });

  const getPull = Effect.fn("OriginSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const match = parsePullRequestUrl(input.reference.trim());
    const target: Target =
      match !== null
        ? { repository: match.repository }
        : yield* resolveTarget("getChangeRequest", input);
    const number = match
      ? String(match.number)
      : /^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1];
    if (number === undefined)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "An Origin pull request is a number or a cursor.com codebase pull request URL.",
      );
    yield* requireNative("getChangeRequest", input.cwd, target.repository);
    const pull = yield* read(
      "getChangeRequest",
      input.cwd,
      { path: `/repos/${target.repository}/pulls/${number}` },
      Json.OriginPull,
    );
    return asChangeRequest(pull, target.repository);
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("origin"),
    repositoryNameFromRemoteUrl: (url) => OriginHosts.parseOriginRemote(url)?.repository ?? null,
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("OriginSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        yield* requireNative("listChangeRequests", input.cwd, target.repository);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const items: Array<ChangeRequest> = [];
        let pageToken: string | undefined;
        do {
          const query = new URLSearchParams({
            head: branch,
            pageSize: String(Math.min(limit, 100)),
            sortBy: "updated",
          });
          if (input.state !== "all") query.set("state", input.state);
          if (pageToken) query.set("pageToken", pageToken);
          const page: typeof Json.OriginPulls.Type = yield* read(
            "listChangeRequests",
            input.cwd,
            { path: `/repos/${target.repository}/pulls?${query}` },
            Json.OriginPulls,
          );
          for (const pull of page.pullRequests) {
            if (items.length >= limit) break;
            if (OriginHosts.shortBranchName(pull.head.ref) !== branch) continue;
            items.push(asChangeRequest(pull, target.repository));
          }
          pageToken =
            page.pullRequests.length === 0 || !page.nextPageToken ? undefined : page.nextPageToken;
        } while (pageToken !== undefined && items.length < limit);
        return items;
      },
    ),
    createChangeRequest: Effect.fn("OriginSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        yield* requireNative("createChangeRequest", input.cwd, target.repository);
        const branch = SourceControlProvider.sourceBranch(input);
        const description = yield* fileSystem
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
        yield* read(
          "createChangeRequest",
          input.cwd,
          {
            method: "POST",
            path: `/repos/${target.repository}/pulls`,
            body: {
              title: input.title,
              head: branch,
              base: input.target?.refName ?? input.baseRefName,
              ...(description.trim().length === 0 ? {} : { body: description }),
            },
          },
          Json.OriginPull,
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("OriginSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        const repo = yield* read(
          "getRepositoryCloneUrls",
          input.cwd,
          { path: `/repos/${target.repository}` },
          Json.OriginRepo,
        );
        return cloneUrls(repo.fullName ?? target.repository, repo.cloneUrl);
      },
    ),
    createRepository: Effect.fn("OriginSourceControlProvider.createRepository")(function* (input) {
      const target = yield* resolveTarget("createRepository", input);
      const [owner = "", name = ""] = target.repository.split("/");
      const visibility =
        input.visibility === "public"
          ? "internal"
          : input.visibility === "private"
            ? "private"
            : "internal";
      const repo = yield* read(
        "createRepository",
        input.cwd,
        {
          method: "POST",
          path: `/repos/${owner}`,
          body: { name, defaultBranch: "main", visibility },
        },
        Json.OriginRepo,
      );
      return cloneUrls(repo.fullName ?? `${owner}/${repo.name}`, repo.cloneUrl);
    }),
    getDefaultBranch: Effect.fn("OriginSourceControlProvider.getDefaultBranch")(function* (input) {
      const target = yield* resolveTarget("getDefaultBranch", input);
      const repository = yield* read(
        "getDefaultBranch",
        input.cwd,
        { path: `/repos/${target.repository}` },
        Json.OriginRepo,
      );
      return repository.defaultBranch ?? null;
    }),
    checkoutChangeRequest: Effect.fn("OriginSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const sourceRepository = pull.headRepositoryNameWithOwner;
        if (!sourceRepository)
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "Origin did not name the pull request's source repository.",
          );
        const contextRemote = input.context
          ? OriginHosts.parseOriginRemote(input.context.remoteUrl)
          : null;
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context && contextRemote?.repository === sourceRepository
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "origin",
                  url: isSshRemote(input.context?.remoteUrl)
                    ? `git@${AUTH_HOST}:${sourceRepository}.git`
                    : `https://${AUTH_HOST}/${sourceRepository}.git`,
                });
          const localBranch = pull.headRefName;
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: pull.headRefName };
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "OriginSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "--no-track",
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
              "Could not check out the Origin pull request.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
