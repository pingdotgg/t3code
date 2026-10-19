import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import type { SourceControlCliDiscoverySpec } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as BrnchCli from "./brnchCli.ts";
import * as Json from "./brnchChangeJson.ts";

const KIND = SourceControlProviderKind.make("brnch");
/** Rows per `change list` page; the CLI has no branch filter, so a branch's changes are a walk. */
const PAGE_SIZE = 100;

export const discovery = {
  type: "cli",
  kind: KIND,
  label: "Brnch",
  executable: "brnch",
  versionArgs: ["--version"],
  authArgs: [...BrnchCli.GLOBAL_ARGS, "auth", "status"],
  parseAuth: BrnchCli.parseAuthStatus,
  installHint: BrnchCli.INSTALL_HINT,
} satisfies SourceControlCliDiscoverySpec;

const changeUrlPattern = /^https:\/\/brnch\.io\/([^/]+\/[^/]+)\/changes\/(\d+)\/?(?:[?#].*)?$/iu;

const cloneUrls = (repository: typeof Json.BrnchRepository.Type) => {
  const nameWithOwner = `${repository.org_slug}/${repository.name}`;
  return {
    nameWithOwner,
    url: `https://${BrnchCli.BRNCH_HOST}/git/${nameWithOwner}.git`,
    sshUrl: `git@${BrnchCli.BRNCH_HOST}:${nameWithOwner}.git`,
  };
};

/** An scp-like `user@host:path` or `ssh://` remote; HTTPS remotes may carry userinfo too. */
const isSshRemote = (remoteUrl: string | undefined) =>
  remoteUrl !== undefined && (/^ssh:\/\//iu.test(remoteUrl) || /^[^/:]+@[^/:]+:/u.test(remoteUrl));

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const cli = yield* BrnchCli.make;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const brnch = <A>(
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, unknown, never, never>,
  ) =>
    cli
      .run({ operation, cwd, args }, schema)
      .pipe(Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)));

  /** The repository a call names, falling back to the checkout's own brnch.io remote. */
  const resolveRepository = Effect.fn("BrnchSourceControlProvider.resolveRepository")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    if (input.repository !== undefined) {
      const named =
        BrnchCli.parseBrnchRemote(input.repository) ??
        BrnchCli.brnchRepositoryPath(input.repository);
      if (named) return named;
      return yield* error(
        operation,
        input.cwd,
        "A Brnch repository is named owner/name or by its brnch.io URL.",
      );
    }
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
        Effect.mapError((cause) =>
          error(operation, input.cwd, "Could not read the Brnch remote.", cause),
        ),
      ));
    const repository = remoteUrl ? BrnchCli.parseBrnchRemote(remoteUrl) : null;
    if (repository) return repository;
    return yield* error(operation, input.cwd, "No brnch.io repository remote was found.");
  });

  const getChange = Effect.fn("BrnchSourceControlProvider.getChange")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const url = changeUrlPattern.exec(input.reference.trim());
    const number = url ? url[2] : /^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1];
    if (number === undefined)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A Brnch change is a number or a brnch.io change URL.",
      );
    const repository = url?.[1] ?? (yield* resolveRepository("getChangeRequest", input));
    const change = yield* brnch(
      "getChangeRequest",
      input.cwd,
      ["change", "view", number, "--repo", repository],
      Json.BrnchChange,
    );
    return Json.toChangeRequest(change, repository);
  });

  const readRepository = (operation: string, cwd: string, repository: string) =>
    brnch(operation, cwd, ["repo", "view", repository], Json.BrnchRepository);

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: BrnchCli.parseBrnchRemote,
    getChangeRequest: getChange,
    listChangeRequests: Effect.fn("BrnchSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repository = yield* resolveRepository("listChangeRequests", input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        // Brnch keeps drafts apart from open changes; both are open here.
        const states =
          input.state === "all"
            ? [null]
            : input.state === "open"
              ? ["open", "draft"]
              : [input.state];
        const items: Array<ChangeRequest> = [];
        for (const state of states) {
          let cursor: string | null = null;
          // Every page until the list ends; a cursor seen before means the host is looping.
          const cursors = new Set<string>();
          while (items.length < limit) {
            const changes: typeof Json.BrnchChanges.Type = yield* brnch(
              "listChangeRequests",
              input.cwd,
              [
                "change",
                "list",
                "--repo",
                repository,
                "--limit",
                String(PAGE_SIZE),
                ...(state === null ? [] : ["--state", state]),
                ...(cursor === null ? [] : ["--cursor", cursor]),
              ],
              Json.BrnchChanges,
            );
            for (const change of changes.items) {
              if (items.length >= limit || Json.headBranch(change) !== branch) continue;
              const item = Json.toChangeRequest(change, repository);
              if (
                (!source?.repository || item.headRepositoryNameWithOwner === source.repository) &&
                (!source?.owner || item.headRepositoryOwnerLogin === source.owner)
              )
                items.push(item);
            }
            if (changes.next_cursor === null || cursors.has(changes.next_cursor)) break;
            cursors.add(changes.next_cursor);
            cursor = changes.next_cursor;
          }
        }
        return items;
      },
    ),
    createChangeRequest: Effect.fn("BrnchSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repository = yield* resolveRepository("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (
          (source?.repository && source.repository !== repository) ||
          (source?.owner && source.owner !== repository.split("/")[0])
        )
          return yield* error(
            "createChangeRequest",
            input.cwd,
            "The Brnch CLI opens changes from branches in the same repository only.",
          );
        yield* brnch(
          "createChangeRequest",
          input.cwd,
          [
            "change",
            "create",
            "--repo",
            repository,
            "--ref",
            `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
            "--target",
            `refs/heads/${input.target?.refName ?? input.baseRefName}`,
            "--title",
            input.title,
            "--file",
            input.bodyFile,
          ],
          Json.BrnchChange,
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("BrnchSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repository = yield* resolveRepository("getRepositoryCloneUrls", input);
        return cloneUrls(yield* readRepository("getRepositoryCloneUrls", input.cwd, repository));
      },
    ),
    createRepository: Effect.fn("BrnchSourceControlProvider.createRepository")(function* (input) {
      const repository = yield* resolveRepository("createRepository", input);
      const [owner = "", name = ""] = repository.split("/");
      const created = yield* brnch(
        "createRepository",
        input.cwd,
        ["repo", "create", name, "--org", owner, "--visibility", input.visibility],
        Json.BrnchRepository,
      );
      return cloneUrls(created);
    }),
    getDefaultBranch: Effect.fn("BrnchSourceControlProvider.getDefaultBranch")(function* (input) {
      const repository = yield* resolveRepository("getDefaultBranch", input);
      return (yield* readRepository("getDefaultBranch", input.cwd, repository)).default_branch;
    }),
    // `brnch` has no checkout command, so the change's branch is fetched and switched to with git.
    checkoutChangeRequest: Effect.fn("BrnchSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const change = yield* getChange(input);
        const sourceRepository = change.headRepositoryNameWithOwner;
        const contextRepository = input.context
          ? BrnchCli.parseBrnchRemote(input.context.remoteUrl)
          : null;
        if (!sourceRepository)
          return yield* error(
            "checkoutChangeRequest",
            input.cwd,
            "Brnch did not name the change's source repository.",
          );
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context && contextRepository === sourceRepository
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "brnch",
                  // SSH only when the checkout already reaches Brnch over SSH; HTTPS otherwise.
                  url: isSshRemote(input.context?.remoteUrl)
                    ? `git@${BrnchCli.BRNCH_HOST}:${sourceRepository}.git`
                    : `https://${BrnchCli.BRNCH_HOST}/git/${sourceRepository}.git`,
                });
          const localBranch = change.isCrossRepository
            ? `change-${change.number}/${change.headRefName}`
            : change.headRefName;
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: change.headRefName };
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          // `checkout -B` moves even the checked-out branch, and refuses to overwrite local edits.
          if (input.force === true)
            yield* git.execute({
              operation: "BrnchSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${change.headRefName}`,
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
              "Could not check out the Brnch change.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
