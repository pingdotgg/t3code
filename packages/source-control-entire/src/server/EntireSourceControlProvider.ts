import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as EntireApi from "./EntireApi.ts";
import * as EntireCli from "./EntireCli.ts";
import * as EntireUrls from "../shared/entireUrls.ts";
import * as Json from "./entireTrailJson.ts";

const KIND = SourceControlProviderKind.make("entire");
const PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 3;

const cliDiscovery = {
  type: "cli",
  kind: KIND,
  label: "Entire",
  executable: "entire",
  versionArgs: ["version"],
  authArgs: ["auth", "status", "--json"],
  probeTimeoutMs: 10_000,
  parseAuth: (input) => {
    const status = Option.getOrUndefined(EntireCli.decodeAuthStatus(input.stdout.trim()));
    if (status === undefined)
      return providerAuth({
        status: "unknown",
        detail: "Entire authentication status could not be read. Run `entire auth status`.",
      });
    if (status.logged_in && status.user)
      return providerAuth({ status: "authenticated", account: status.user, host: status.server });
    return providerAuth({
      // `logged_in: false` with an `error` can be an unreachable login server, not a sign-out.
      status: status.error && !/entire login/u.test(status.error) ? "unknown" : "unauthenticated",
      host: status.server,
      detail: status.error ?? "Run `entire login` on the server.",
    });
  },
  installHint: "Install the Entire CLI from https://entire.com, then run `entire login`.",
} satisfies SourceControlCliDiscoverySpec;

export const parseAuth = cliDiscovery.parseAuth;

export const makeDiscovery = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  return {
    type: "managed-cli",
    kind: cliDiscovery.kind,
    label: cliDiscovery.label,
    installHint: cliDiscovery.installHint,
    probe: (cwd: string) =>
      probeSourceControlProvider({
        cwd,
        spec: cliDiscovery,
        process: {
          run: (input) =>
            process.run({ ...input, env: { ...input.env, ...EntireCli.ENTIRE_CLI_ENV } }),
        },
      }),
    // Entire is recognised by its `entire://` scheme, so no unknown host is Entire's.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

const RepositoryMeta = Schema.Struct({ default_branch: Schema.optional(Schema.String) });
const OwnedRepository = Schema.Struct({
  owning_project_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const CreatedProjectTrail = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  number: Schema.Int,
});
const LinkedChange = Schema.Struct({ trailId: Schema.String, repositoryId: Schema.String });

interface Target {
  readonly repository: string;
  readonly remote: { readonly name: string | null; readonly url: string } | null;
}

export const make = Effect.gen(function* () {
  const api = yield* EntireApi.EntireApi;
  const cli = yield* EntireCli.EntireCli;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const requestJson = <S extends Schema.Codec<unknown, unknown, never, never>>(
    request: EntireApi.EntireApiRequest,
    schema: S,
  ) =>
    api
      .requestJson(request, schema)
      .pipe(Effect.mapError((cause) => error(request.operation, request.cwd, cause.detail, cause)));

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    target: Target,
    request: Pick<EntireApi.EntireApiRequest, "path">,
    schema: S,
  ) =>
    requestJson(
      { ...request, cwd, repository: target.repository, remoteUrl: target.remote?.url, operation },
      schema,
    ).pipe(Effect.map(({ body }) => body));

  const checkoutRemote = (
    cwd: string,
    context: SourceControlProvider.SourceControlProviderContext | undefined,
  ) => {
    if (!context) return EntireApi.checkoutEntireRemote(host.git, cwd);
    const remote = EntireUrls.parseEntireRemote(context.remoteUrl);
    return Effect.succeed(remote && { ...remote, name: context.remoteName });
  };

  const resolveTarget = Effect.fn("EntireSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    // A git failure costs a named repository only its remote; otherwise it is the cause.
    const remoteRead = yield* Effect.result(checkoutRemote(input.cwd, input.context));
    const own = Result.isSuccess(remoteRead) ? remoteRead.success : null;
    const ownTarget: Target | null = own
      ? { repository: own.repository, remote: { name: own.name, url: own.remoteUrl } }
      : null;
    if (input.repository === undefined) {
      if (ownTarget) return ownTarget;
      return yield* error(
        operation,
        input.cwd,
        "No Entire repository remote was found.",
        Result.isFailure(remoteRead) ? remoteRead.failure : undefined,
      );
    }
    const clone = EntireUrls.parseEntireRemote(input.repository);
    const named =
      clone ??
      EntireUrls.parseEntireTrailUrl(input.repository) ??
      EntireUrls.parseEntireRepositoryUrl(input.repository) ??
      EntireUrls.entireRepositoryPath(input.repository);
    if (named === null)
      return yield* error(
        operation,
        input.cwd,
        "An Entire repository is named gh/<owner>/<repo>, et/<project>/<repo>, its entire.com page, or its entire:// URL.",
      );
    if (ownTarget && ownTarget.repository.toLowerCase() === named.repository.toLowerCase())
      return ownTarget;
    return {
      repository: named.repository,
      remote: clone ? { name: null, url: clone.remoteUrl } : null,
    } satisfies Target;
  });

  const getTrail = Effect.fn("EntireSourceControlProvider.getTrail")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const link = EntireUrls.parseEntireTrailUrl(input.reference);
    const target = yield* resolveTarget(
      "getChangeRequest",
      link === null ? input : { ...input, repository: link.repository },
    );
    const number = link?.number ?? Number(/^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1]);
    if (!Number.isSafeInteger(number))
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "An Entire change is its number in this repository, or a link to it on entire.com.",
      );
    const trail = yield* read(
      "getChangeRequest",
      input.cwd,
      target,
      { path: `/trails/${number}` },
      Json.EntireTrailDetail,
    );
    return { target, trail };
  });

  const toChangeRequest = (
    trail: Json.EntireTrail & { readonly head_sha?: string | null | undefined },
    target: Target,
  ): ChangeRequest => {
    const head = trail.head_sha?.trim();
    const branch = Json.trailHeadBranch(trail).trim();
    return {
      provider: KIND,
      number: trail.number,
      title: Json.trailTitle(trail),
      url: Json.trailUrl(trail, target.repository),
      baseRefName: trail.base,
      headRefName: branch || `trail-${trail.number}`,
      ...(head ? { headSha: head } : {}),
      state: Json.trailState(trail.status),
      ...(Json.isDraftTrail(trail) ? { isDraft: true } : {}),
      mergedAt: trail.merged_at ?? null,
      updatedAt: DateTime.make(trail.updated_at),
      isCrossRepository: false,
      headRepositoryNameWithOwner: target.repository,
    };
  };

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: (url) => EntireUrls.parseEntireRemote(url)?.repository ?? null,
    getChangeRequest: Effect.fn("EntireSourceControlProvider.getChangeRequest")((input) =>
      getTrail(input).pipe(Effect.map(({ trail, target }) => toChangeRequest(trail, target))),
    ),
    listChangeRequests: Effect.fn("EntireSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const items: Array<ChangeRequest> = [];
        // The trail list has no exact branch filter; its search narrows the list to trails whose
        // title or branch contains the name, and the branch's own are picked from those.
        let cursor: string | null = null;
        for (let page = 0; items.length < limit; page++) {
          if (page === MAX_BRANCH_PAGES)
            return yield* error(
              "listChangeRequests",
              input.cwd,
              `Entire lists too many trails matching ${branch} to tell which are this branch's.`,
            );
          const query = new URLSearchParams({ per_page: String(PAGE_SIZE), q: branch });
          if (input.state !== "all")
            query.set("status", input.state === "open" ? "draft,open" : input.state);
          if (cursor !== null) query.set("cursor", cursor);
          const batch: typeof Json.EntireTrails.Type = yield* read(
            "listChangeRequests",
            input.cwd,
            target,
            { path: `/trails?${query}` },
            Json.EntireTrails,
          );
          for (const trail of batch.items)
            if (Json.trailHeadBranch(trail) === branch && items.length < limit)
              items.push(toChangeRequest(trail, target));
          const previous: string | null = cursor;
          cursor = batch.next_cursor ?? null;
          if (cursor === null || cursor === previous) break;
        }
        return items;
      },
    ),
    createChangeRequest: Effect.fn("EntireSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the trail description.",
                cause,
              ),
            ),
          );
        const operation = "createChangeRequest";
        const located = {
          cwd: input.cwd,
          repository: target.repository,
          remoteUrl: target.remote?.url,
          operation,
        };
        const coordinates = yield* api
          .repository(located)
          .pipe(Effect.mapError((cause) => error(operation, input.cwd, cause.detail, cause)));
        // The CLI names no owning project for a repository mirrored from GitHub.
        const projectId =
          coordinates.projectId ??
          (yield* requestJson({ ...located, path: "" }, OwnedRepository).pipe(
            Effect.map((repository) => repository.body.owning_project_id?.trim() || null),
          ));
        if (projectId === null)
          return yield* error(
            operation,
            input.cwd,
            `Entire did not say which project owns ${target.repository}.`,
          );
        const branch = SourceControlProvider.sourceBranch(input);
        const description = body.trim().length === 0 ? {} : { body };
        // A trail belongs to the project; the branch is linked to it as this repository's change.
        // No idempotency key: Entire takes one on this create only from project managers, and
        // refuses it from the repository writers who may otherwise create here.
        const created = yield* requestJson(
          {
            ...located,
            scope: "project",
            method: "POST",
            path: `?${new URLSearchParams({ project_id: projectId })}`,
            body: { title: input.title, ...description, repoIds: [coordinates.repoId] },
          },
          CreatedProjectTrail,
        );
        const trail = created.body;
        const linkByHand = `Link it with \`entire trail link ${trail.number} --branch ${branch}\` rather than creating another trail.`;
        if (trail.projectId !== projectId)
          return yield* error(operation, input.cwd, "Entire created the trail in another project.");
        if (created.etag === null)
          return yield* error(
            operation,
            input.cwd,
            `Entire created trail #${trail.number} without a version to link ${branch} against. ${linkByHand}`,
          );
        const linked = yield* api
          .requestJson(
            {
              ...located,
              scope: "project",
              method: "POST",
              path: `/${encodeURIComponent(trail.id)}/changes`,
              headers: {
                "if-match": created.etag,
                // Derived, not random: a retry of this same link must not link twice.
                "idempotency-key": `t3code-${trail.id}-${coordinates.repoId}`,
              },
              body: {
                repositoryId: coordinates.repoId,
                title: input.title,
                ...description,
                branchName: branch,
                // T3 Code pushes the branch first; `create` would make Entire branch it again.
                branchAction: "link",
                base: input.target?.refName ?? input.baseRefName,
              },
            },
            LinkedChange,
          )
          .pipe(
            Effect.mapError((cause) =>
              error(
                operation,
                input.cwd,
                `Entire created trail #${trail.number} but could not link ${branch}: ${cause.detail}. ${linkByHand}`,
                cause,
              ),
            ),
          );
        const change = linked.body;
        if (change.trailId !== trail.id || change.repositoryId !== coordinates.repoId)
          return yield* error(operation, input.cwd, "Entire linked the branch somewhere else.");
      },
    ),
    getRepositoryCloneUrls: Effect.fn("EntireSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        const url =
          target.remote?.url ??
          (yield* cli.repository(`/${target.repository}`).pipe(
            Effect.mapError((cause) =>
              error("getRepositoryCloneUrls", input.cwd, cause.message, cause),
            ),
            Effect.map(({ cluster }) =>
              cluster !== null && EntireUrls.isEntireCluster(cluster)
                ? `entire://${cluster}/${target.repository}`
                : null,
            ),
          ));
        if (url === null)
          return yield* error(
            "getRepositoryCloneUrls",
            input.cwd,
            `Entire did not name a cluster host for ${target.repository}.`,
          );
        return { nameWithOwner: target.repository, url, sshUrl: url };
      },
    ),
    createRepository: Effect.fn("EntireSourceControlProvider.createRepository")((input) =>
      Effect.fail(
        error(
          "createRepository",
          input.cwd,
          "Create Entire repositories with `entire repo create`, then add them to T3 Code.",
        ),
      ),
    ),
    getDefaultBranch: Effect.fn("EntireSourceControlProvider.getDefaultBranch")(function* (input) {
      const target = yield* resolveTarget("getDefaultBranch", input);
      const meta = yield* read("getDefaultBranch", input.cwd, target, { path: "" }, RepositoryMeta);
      return meta.default_branch?.trim() || null;
    }),
    checkoutChangeRequest: Effect.fn("EntireSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const { trail, target } = yield* getTrail(input);
        const branch = Json.trailHeadBranch(trail).trim();
        const remoteName = target.remote?.name;
        if (!branch)
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "This trail has no branch to check out yet.",
          );
        if (!remoteName)
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "Check out a trail from a clone of its Entire repository.",
          );
        const git = host.git;
        // The name goes into fetch refspecs, where `:` or `*` would change what is fetched.
        yield* git
          .execute({
            operation: "EntireSourceControlProvider.checkoutChangeRequest",
            cwd: input.cwd,
            args: ["check-ref-format", `refs/heads/${branch}`],
          })
          .pipe(
            Effect.mapError((cause) =>
              error(
                "checkoutChangeRequest",
                input.cwd,
                "Entire named a branch git cannot check out.",
                cause,
              ),
            ),
          );
        yield* Effect.gen(function* () {
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: branch };
          if (input.force !== true && !branches.includes(branch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch: branch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "EntireSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: ["checkout", "-B", branch, `refs/remotes/${remoteName}/${branch}`, "--"],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: branch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out the Entire trail.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
