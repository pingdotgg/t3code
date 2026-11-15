import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { initializeWorkspaceSubmodules } from "./initializeWorkspaceSubmodules.ts";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

const MAX_WORKSPACE_NAME_ATTEMPTS = 100;
const MAX_WORKSPACE_NAME_LENGTH = 96;
const LIST_REFS_PAGE_SIZE = 500;
const LIST_REFS_DEFAULT_LIMIT = 100;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;

export function sanitizeWorklerWorkspaceName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_WORKSPACE_NAME_LENGTH)
    .replace(/[-_]+$/g, "");
  const safeName = sanitized.length === 0 ? "workspace" : sanitized;
  return WINDOWS_RESERVED_NAME.test(safeName) ? `workspace-${safeName}` : safeName;
}

export function mapWorklerError(
  operation: string,
  cwd: string,
  error: WorklerWorkspaceService.WorklerWorkspaceError,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: "workler",
    cwd,
    detail: error.detail,
    cause: error,
  });
}

/**
 * Before deleting a clone, preserve branches, tags and checkpoints in its source;
 * conflicting tags go under `refs/t3/kept-tags/<object>/<tag>`.
 * Keep the clone if preservation would overwrite a source branch (including the
 * current branch needed for resume), or if it contains stashes or unbranched commits.
 */
export const keepWorklerCloneRefs = Effect.fn("WorklerGitWorkspaceDriver.keepCloneRefs")(function* (
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">,
  input: { readonly source: string; readonly clone: string },
) {
  const operation = "WorklerGitWorkspaceDriver.keepCloneRefs";
  const kept = (reason: string) =>
    new GitCommandError({
      operation,
      command: "git",
      cwd: input.clone,
      detail: `Kept ${input.clone}, because ${reason}`,
    });
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args, allowNonZeroExit: true });
  const listRefs = Effect.fn(function* (cwd: string) {
    const listed = yield* git.execute({
      operation,
      cwd,
      args: ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
    });
    return new Map(
      listed.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => [line.slice(line.indexOf(" ") + 1), line.slice(0, line.indexOf(" "))]),
    );
  });
  // True when every commit `ref` reaches is also reached from `from`.
  const reachedFrom = Effect.fn(function* (ref: string, from: ReadonlyArray<string>) {
    const result = yield* git.execute({
      operation,
      cwd: input.clone,
      args: ["rev-list", "--max-count=1", ref, "--not", ...from],
    });
    return result.stdout.trim() === "";
  });
  // The project's branches as they are now, for checks inside the clone.
  let mirrored = false;
  const mirrorSourceBranches = Effect.fn(function* () {
    if (mirrored) return;
    mirrored = true;
    yield* git.execute({
      operation,
      cwd: input.clone,
      args: [
        "fetch",
        "--no-recurse-submodules",
        "--no-tags",
        "--no-write-fetch-head",
        "--prune",
        input.source,
        "+refs/heads/*:refs/remotes/workler-root/*",
      ],
    });
  });

  if (
    (yield* run(input.clone, ["rev-parse", "--verify", "--quiet", "refs/stash"])).exitCode === 0
  ) {
    return yield* kept("it has stashed changes. Apply or drop them (git stash list) first.");
  }
  const head = yield* run(input.clone, ["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = head.exitCode === 0 ? head.stdout.trim() : null;
  if (headRef === null) {
    // A rebase or bisect stopped halfway leaves commits that only HEAD reaches.
    yield* mirrorSourceBranches();
    if (!(yield* reachedFrom("HEAD", ["--branches", "--tags", "--remotes"]))) {
      return yield* kept(
        "its HEAD has commits on no branch, maybe from a rebase that stopped halfway. Finish or abort it first.",
      );
    }
  }

  const sourceRefs = yield* listRefs(input.source);
  const copy: Array<string> = [];
  const fastForwardIfAllowed: Array<string> = [];
  for (const [ref, objectName] of yield* listRefs(input.clone)) {
    const sourceObjectName = sourceRefs.get(ref);
    if (sourceObjectName === objectName) continue;
    if (sourceObjectName === undefined) {
      copy.push(`${ref}:${ref}`);
      continue;
    }
    if (ref.startsWith("refs/tags/")) {
      // The project uses this tag name for something else. Keep the clone's
      // tag (and an annotated tag's message) under a name that can't clash;
      // the object ID in it means the copy never overwrites anything.
      copy.push(`${ref}:refs/t3/kept-tags/${objectName}/${ref.slice("refs/tags/".length)}`);
      continue;
    }
    yield* mirrorSourceBranches();
    const branch = ref.slice("refs/heads/".length);
    // The project's branch already holds everything (e.g. it moved on since).
    if (yield* reachedFrom(ref, [`refs/remotes/workler-root/${branch}`])) continue;
    // Pushed, so nothing would be lost; only the current branch is needed by name.
    const pushed = yield* reachedFrom(ref, ["--remotes"]);
    if (pushed && ref !== headRef) continue;
    // The current branch is pushed and the project's is only behind it, so
    // resume stays on the same history. Git refuses to move a branch that is
    // checked out there, which is fine.
    if (pushed && (yield* reachedFrom(`refs/remotes/workler-root/${branch}`, [ref]))) {
      fastForwardIfAllowed.push(`${ref}:${ref}`);
      continue;
    }
    // Fast-forward only; git refuses otherwise, or when it's checked out there.
    copy.push(`${ref}:${ref}`);
  }

  const fetchFromClone = (refspecs: ReadonlyArray<string>) =>
    run(input.source, [
      "fetch",
      // Submodules would reach their remotes and fail offline.
      "--no-recurse-submodules",
      // A user's fetch.prune (and fetch.pruneTags) would otherwise delete
      // every project checkpoint and tag the clone doesn't have.
      "--no-prune",
      "--no-tags",
      "--no-write-fetch-head",
      input.clone,
      ...refspecs,
    ]);
  const copied = yield* fetchFromClone([
    ...copy,
    "+refs/t3/checkpoints/*:refs/t3/checkpoints/*",
    "+refs/t3/orchestration-v2/checkpoints/*:refs/t3/orchestration-v2/checkpoints/*",
  ]);
  if (copied.exitCode !== 0) {
    return yield* kept(
      `its branches couldn't be copied into ${input.source} without losing work there. ${copied.stderr.trim()}`,
    );
  }
  if (fastForwardIfAllowed.length > 0) yield* fetchFromClone(fastForwardIfAllowed);
});

/** Whether `clone` is a Workler clone made from the repository at `source`. */
const isWorklerCloneOf = Effect.fn("WorklerGitWorkspaceDriver.isWorklerCloneOf")(function* (
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">,
  input: { readonly source: string; readonly clone: string },
) {
  const operation = "WorklerGitWorkspaceDriver.isWorklerCloneOf";
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
  const recorded = yield* run(input.clone, ["config", "--local", "--get", "workler.root"]);
  if (recorded === "") return false;
  // Workler records a native real path (backslashes on Windows); let Git spell both alike.
  const [recordedTop, sourceTop] = yield* Effect.all([
    run(recorded, ["rev-parse", "--show-toplevel"]),
    run(input.source, ["rev-parse", "--show-toplevel"]),
  ]);
  return recordedTop !== "" && recordedTop === sourceTop;
});

/** Makes `commit` from a clone available in its `source` repository: objects only, no ref changes. */
export const copyCloneCommit = Effect.fn("WorklerGitWorkspaceDriver.copyCloneCommit")(function* (
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">,
  input: { readonly source: string; readonly clone: string; readonly commit: string },
) {
  const operation = "WorklerGitWorkspaceDriver.copyCloneCommit";
  const present = yield* git.execute({
    operation,
    cwd: input.source,
    args: ["cat-file", "-e", `${input.commit}^{commit}`],
    allowNonZeroExit: true,
  });
  if (present.exitCode === 0) return;
  // Only a clone of `source` holds history that belongs there.
  if (!(yield* isWorklerCloneOf(git, input).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new GitCommandError({
      operation,
      command: "git fetch",
      cwd: input.source,
      detail: `${input.clone} is not a Workler clone of ${input.source}, so its commits were not copied.`,
    });
  }
  yield* git.execute({
    operation,
    cwd: input.source,
    args: [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      input.clone,
      input.commit,
    ],
  });
});

function isPathInside(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeManagedWorkspace(
  path: Path.Path,
  root: string,
  workspace: WorklerWorkspaceService.WorklerWorkspaceSummary,
): WorklerWorkspaceService.WorklerWorkspaceSummary | null {
  if (workspace.isMain || !workspace.isClone || workspace.broken !== null) return null;
  const workspacePath = path.normalize(path.resolve(workspace.path));
  const workspacesRoot = path.join(path.normalize(path.resolve(root)), ".worktrees");
  return isPathInside(path, workspacesRoot, workspacePath)
    ? { ...workspace, path: workspacePath }
    : null;
}

function paginateRefs(
  refs: ReadonlyArray<VcsRef>,
  input: VcsListRefsInput,
): Pick<VcsListRefsResult, "refs" | "nextCursor" | "totalCount"> {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? LIST_REFS_DEFAULT_LIMIT;
  const page = refs.slice(cursor, cursor + limit);
  return {
    refs: page,
    nextCursor: cursor + page.length < refs.length ? cursor + page.length : null,
    totalCount: refs.length,
  };
}

export const withWorklerWorkspaceSupport = (input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly workler: WorklerWorkspaceService.WorklerWorkspaceService["Service"];
  readonly path: Path.Path;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly settings?: ServerSettingsService["Service"] | undefined;
}): GitVcsDriver.GitVcsDriver["Service"] => {
  const resolveRoot = Effect.fn("WorklerGitWorkspaceDriver.resolveRoot")(function* (cwd: string) {
    const result = yield* input.git.execute({
      operation: "WorklerGitWorkspaceDriver.resolveRoot",
      cwd,
      args: ["rev-parse", "--show-toplevel"],
      timeoutMs: 10_000,
    });
    return result.stdout.trim() || cwd;
  });

  const worklerEnabled = Effect.fn("WorklerGitWorkspaceDriver.worklerEnabled")(function* (
    cwd: string,
  ) {
    // Focused Git tests and embedded callers that do not provide server settings
    // keep the upstream-native creation strategy.
    if (!input.settings) return false;
    return yield* input.settings.getSettings.pipe(
      Effect.map((value) => value.useWorklerForNewWorkspaces),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.createWorktree",
            command: "settings",
            cwd,
            detail: "Failed to read the Workler workspace creation setting.",
            cause,
          }),
      ),
    );
  });

  const createWorktree = Effect.fn("WorklerGitWorkspaceDriver.createWorktree")(function* (
    createInput: VcsCreateWorktreeInput,
    options?: GitVcsDriver.CreateWorktreeOptions,
  ): Effect.fn.Return<VcsCreateWorktreeResult, GitCommandError> {
    if (!(yield* worklerEnabled(createInput.cwd)) || createInput.path !== null) {
      return yield* input.git.createWorktree(createInput, options);
    }
    // Workler reports the claim after cloning; submodule work follows that claim.

    const root = yield* resolveRoot(createInput.cwd);
    const existing = yield* input.workler
      .listWorkspaces(root)
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.createWorktree", createInput.cwd, error),
        ),
      );
    const managedWorkspaces = existing.flatMap((workspace) => {
      const managed = normalizeManagedWorkspace(input.path, root, workspace);
      return managed ? [managed] : [];
    });
    const targetBranch = createInput.newRefName ?? createInput.refName;
    if (managedWorkspaces.some((workspace) => workspace.branch === targetBranch)) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: `Branch '${targetBranch}' is already checked out in a Workler workspace.`,
      });
    }

    const usedNames = new Set(existing.map((workspace) => workspace.name));
    const baseName = sanitizeWorklerWorkspaceName(targetBranch);
    let workspaceName: string | null = null;
    for (let attempt = 0; attempt < MAX_WORKSPACE_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
      if (!usedNames.has(candidate)) {
        workspaceName = candidate;
        break;
      }
    }
    if (workspaceName === null) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: `Could not find an available Workler workspace name for '${baseName}'.`,
      });
    }

    const workspace = yield* input.workler
      .createWorkspace(
        createInput.newRefName
          ? {
              root,
              name: workspaceName,
              branch: createInput.newRefName,
              base: createInput.refName,
            }
          : { root, name: workspaceName, checkout: createInput.refName },
      )
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.createWorktree", createInput.cwd, error),
        ),
        // The Workler call finishes even after a cancel, so claim the workspace
        // before the interrupt lands; bootstrap then removes it.
        Effect.tap(
          (workspace) => options?.progress?.onWorktreeClaimed?.(workspace.path) ?? Effect.void,
        ),
        Effect.uninterruptible,
      );
    const managedWorkspace = normalizeManagedWorkspace(input.path, root, {
      ...workspace,
      isMain: false,
      isClone: true,
      broken: null,
    });
    if (!managedWorkspace) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: "Workler returned a workspace path outside the repository's .worktrees directory.",
      });
    }

    if (input.fileSystem)
      yield* initializeWorkspaceSubmodules({
        cwd: managedWorkspace.path,
        fileSystem: input.fileSystem,
        path: input.path,
        git: input.git,
        options,
      });

    if (createInput.newRefName && createInput.baseRefName) {
      const remoteNames = yield* input.git
        .execute({
          operation: "WorklerGitWorkspaceDriver.remoteNames",
          cwd: createInput.cwd,
          args: ["remote"],
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => parseRemoteNames(result.stdout)),
          Effect.orElseSucceed(() => []),
        );
      // Launch passes a fetched base as refs/remotes/<remote>/<branch>. gh wants the
      // branch name; T3 diffs against the full remote ref, like GitVcsDriver.createWorktree.
      const remoteBase = createInput.baseRefName.startsWith("refs/heads/")
        ? null
        : parseRemoteRefWithRemoteNames(
            createInput.baseRefName.replace(/^refs\/remotes\//, ""),
            remoteNames,
          );
      const baseBranch =
        remoteBase?.branchName ?? createInput.baseRefName.replace(/^refs\/heads\//, "");
      yield* input.git.execute({
        operation: "GitVcsDriver.createWorktree.configureBaseRef",
        cwd: managedWorkspace.path,
        args: ["config", `branch.${createInput.newRefName}.gh-merge-base`, baseBranch],
        timeoutMs: 10_000,
      });
      if (remoteBase) {
        yield* input.git.execute({
          operation: "GitVcsDriver.createWorktree.configureComparisonRef",
          cwd: managedWorkspace.path,
          args: [
            "config",
            `branch.${createInput.newRefName}.t3-merge-base-ref`,
            `refs/remotes/${remoteBase.remoteRef}`,
          ],
          timeoutMs: 10_000,
        });
      }
      if (remoteBase && /^[0-9a-f]{40}$/i.test(createInput.refName)) {
        yield* input.git.execute({
          operation: "GitVcsDriver.createWorktree.pinBaseTrackingRef",
          cwd: managedWorkspace.path,
          args: ["update-ref", `refs/remotes/${remoteBase.remoteRef}`, createInput.refName],
          timeoutMs: 10_000,
        });
      }
    }

    return {
      worktree: {
        path: managedWorkspace.path,
        refName: workspace.branch ?? targetBranch,
      },
    };
  });

  const listAllNativeRefs = Effect.fn("WorklerGitWorkspaceDriver.listAllNativeRefs")(function* (
    listInput: VcsListRefsInput,
  ) {
    const { cursor: _cursor, limit: _limit, ...query } = listInput;
    const refs: Array<VcsRef> = [];
    let cursor: number | null = 0;
    let result: VcsListRefsResult | null = null;
    while (cursor !== null) {
      const page: VcsListRefsResult = yield* input.git.listRefs({
        ...query,
        cursor,
        limit: LIST_REFS_PAGE_SIZE,
      });
      refs.push(...page.refs);
      result = page;
      if (page.nextCursor !== null && page.nextCursor <= cursor) {
        return { result: page, refs };
      }
      cursor = page.nextCursor;
    }
    return { result, refs };
  });

  const listRefs = Effect.fn("WorklerGitWorkspaceDriver.listRefs")(function* (
    listInput: VcsListRefsInput,
  ): Effect.fn.Return<VcsListRefsResult, GitCommandError> {
    const group = yield* input.workler
      .inspectGroup(listInput.cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (group !== null) {
      const root =
        input.path.basename(input.path.dirname(listInput.cwd)) === ".worktrees"
          ? input.path.dirname(input.path.dirname(listInput.cwd))
          : listInput.cwd;
      const workspaces = yield* input.workler
        .listWorkspaces(root)
        .pipe(Effect.mapError((error) => mapWorklerError("GitVcsDriver.listRefs", root, error)));
      const refs: VcsRef[] = workspaces.flatMap((workspace) => {
        const managed = normalizeManagedWorkspace(input.path, root, workspace);
        return managed?.branch &&
          listInput.refKind !== "remote" &&
          (!listInput.query || managed.branch.toLowerCase().includes(listInput.query.toLowerCase()))
          ? [
              {
                name: managed.branch,
                current: managed.path === listInput.cwd,
                isRemote: false,
                isDefault: false,
                worktreePath: managed.path,
              },
            ]
          : [];
      });
      return { isRepo: false, hasPrimaryRemote: false, ...paginateRefs(refs, listInput) };
    }
    const nativeRefs = yield* input.git.listRefs(listInput);
    if (!nativeRefs.isRepo || listInput.refKind === "remote") return nativeRefs;

    const root = yield* resolveRoot(listInput.cwd).pipe(Effect.orElseSucceed(() => null));
    if (!root) return nativeRefs;
    const workspaces = yield* input.workler.listWorkspaces(root).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Workler workspace listing failed; using native Git refs", {
          cwd: listInput.cwd,
          detail: error.detail,
        }).pipe(Effect.as([])),
      ),
    );
    const query = listInput.query?.toLowerCase();
    const managedWorkspaces = workspaces.flatMap((workspace) => {
      const managed = normalizeManagedWorkspace(input.path, root, workspace);
      return managed?.branch && (!query || managed.branch.toLowerCase().includes(query))
        ? [managed as typeof managed & { readonly branch: string }]
        : [];
    });
    if (managedWorkspaces.length === 0) return nativeRefs;

    const allNative = yield* listAllNativeRefs(listInput);
    if (!allNative.result?.isRepo) return nativeRefs;
    const workspacePathByBranch = new Map<string, string>();
    for (const workspace of managedWorkspaces) {
      if (!workspacePathByBranch.has(workspace.branch)) {
        workspacePathByBranch.set(workspace.branch, workspace.path);
      }
    }

    const mergedNative = allNative.refs.map((ref) => {
      const worktreePath = !ref.isRemote ? workspacePathByBranch.get(ref.name) : undefined;
      return worktreePath && ref.worktreePath === null ? { ...ref, worktreePath } : ref;
    });
    const nativeLocalNames = new Set(
      mergedNative.filter((ref) => !ref.isRemote).map((ref) => ref.name),
    );
    const worklerRefs: Array<VcsRef> = [...workspacePathByBranch].flatMap(([name, worktreePath]) =>
      nativeLocalNames.has(name)
        ? []
        : [
            {
              name,
              current: false,
              isRemote: false,
              isDefault: false,
              worktreePath,
            },
          ],
    );
    const firstRemoteIndex = mergedNative.findIndex((ref) => ref.isRemote);
    const insertionIndex = firstRemoteIndex === -1 ? mergedNative.length : firstRemoteIndex;
    const merged = [
      ...mergedNative.slice(0, insertionIndex),
      ...worklerRefs,
      ...mergedNative.slice(insertionIndex),
    ];
    const deduplicated = listInput.includeMatchingRemoteRefs
      ? merged
      : dedupeRemoteBranchesWithLocalMatches(merged);
    return {
      ...allNative.result,
      ...paginateRefs(deduplicated, listInput),
    };
  });

  const removeWorktree = Effect.fn("WorklerGitWorkspaceDriver.removeWorktree")(function* (
    removeInput: VcsRemoveWorktreeInput,
  ): Effect.fn.Return<void, GitCommandError> {
    const gitRemoval = yield* input.git.removeWorktree(removeInput).pipe(Effect.result);
    if (Result.isSuccess(gitRemoval)) return;

    const root = yield* resolveRoot(removeInput.cwd).pipe(Effect.orElseSucceed(() => null));
    if (!root) return yield* gitRemoval.failure;
    const workspaces = yield* input.workler
      .listWorkspaces(root)
      .pipe(Effect.orElseSucceed(() => []));
    const resolvedPath = input.path.normalize(
      input.path.resolve(removeInput.cwd, removeInput.path),
    );
    // Git canonicalizes parent symlinks (notably /var on macOS), while the
    // caller can retain the path originally returned by Workler.
    const requestedPath = input.fileSystem
      ? yield* input.fileSystem
          .realPath(resolvedPath)
          .pipe(Effect.orElseSucceed(() => resolvedPath))
      : resolvedPath;
    const workspace = workspaces.find((candidate) => {
      const managed = normalizeManagedWorkspace(input.path, root, candidate);
      return managed?.path === requestedPath;
    });
    if (!workspace) return yield* gitRemoval.failure;

    yield* keepWorklerCloneRefs(input.git, { source: root, clone: requestedPath });
    return yield* input.workler
      .removeWorkspace({
        root,
        name: workspace.name,
        ...(removeInput.force === undefined ? {} : { force: removeInput.force }),
      })
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.removeWorktree", removeInput.cwd, error),
        ),
        Effect.asVoid,
      );
  });

  const listWorktreePaths = Effect.fn("WorklerGitWorkspaceDriver.listWorktreePaths")(function* (
    cwd: string,
  ) {
    const native = yield* input.git.listWorktreePaths(cwd).pipe(Effect.result);
    const group = yield* input.workler.inspectGroup(cwd).pipe(Effect.orElseSucceed(() => null));
    const root =
      group !== null ? cwd : yield* resolveRoot(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const workspaces = yield* input.workler
      .listWorkspaces(root)
      .pipe(Effect.orElseSucceed(() => []));
    const managed = workspaces.flatMap((workspace) => {
      const normalized = normalizeManagedWorkspace(input.path, root, workspace);
      return normalized === null ? [] : [normalized.path];
    });
    if (native._tag === "Failure" && managed.length === 0) return yield* native.failure;
    return [...new Set([...(native._tag === "Success" ? native.success : []), ...managed])];
  });

  return {
    ...input.git,
    listWorktreePaths,
    createWorktree,
    listRefs,
    removeWorktree,
  };
};
