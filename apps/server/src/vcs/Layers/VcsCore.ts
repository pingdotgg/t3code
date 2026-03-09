import { mkdir, rm } from "node:fs/promises";
import {
  type GitStatusResult,
  type VcsCapabilities,
  type VcsCheckoutRefInput,
  type VcsCreateWorkspaceInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Effect, Layer, Path } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { VcsUnsupportedError } from "../Errors.ts";
import { VcsCommandError, type VcsServiceError } from "../Errors.ts";
import { VcsCore, type VcsCoreShape } from "../Services/VcsCore.ts";
import { VcsProcess } from "../Services/VcsProcess.ts";
import { VcsResolver } from "../Services/VcsResolver.ts";

interface JjBookmarkRow {
  readonly name?: string;
  readonly remote?: string;
}

interface JjLocalBookmark {
  readonly name?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function buildJjRevision(refName: string, refKind: VcsRef["kind"]) {
  if (refKind !== "remoteBookmark") {
    return refName;
  }
  const separatorIndex = refName.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === refName.length - 1) {
    return refName;
  }
  return refName;
}

function toVcsServiceError(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly command: string;
}) {
  return (error: unknown): VcsServiceError => {
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (((error as { readonly _tag?: string })._tag === "VcsCommandError") ||
        ((error as { readonly _tag?: string })._tag === "VcsUnsupportedError"))
    ) {
      return error as VcsServiceError;
    }

    return new VcsCommandError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      detail: error instanceof Error ? error.message : String(error),
      ...(error !== undefined ? { cause: error } : {}),
    });
  };
}

function sanitizeWorkspaceFragment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/@/g, "-");
  const cleaned = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "");
  return cleaned.length > 0 ? cleaned : "workspace";
}

function parseJsonLines<T>(stdout: string): T[] {
  const parsed: T[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    parsed.push(JSON.parse(trimmed) as T);
  }
  return parsed;
}

function toGitVcsStatus(input: {
  readonly status: GitStatusResult;
  readonly capabilities: VcsCapabilities;
}): VcsStatusResult {
  return {
    backend: "git",
    capabilities: input.capabilities,
    refName: input.status.branch,
    refKind: input.status.branch ? "branch" : null,
    hasWorkingTreeChanges: input.status.hasWorkingTreeChanges,
    workingTree: input.status.workingTree,
    hasUpstream: input.status.hasUpstream,
    aheadCount: input.status.aheadCount,
    behindCount: input.status.behindCount,
    pr: input.status.pr
      ? {
          number: input.status.pr.number,
          title: input.status.pr.title,
          url: input.status.pr.url,
          baseRef: input.status.pr.baseBranch,
          headRef: input.status.pr.headBranch,
          state: input.status.pr.state,
        }
      : null,
  };
}

const makeVcsCore = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess;
  const vcsResolver = yield* VcsResolver;

  const resolve = vcsResolver.resolve;

  const runJj = (
    cwd: string,
    args: ReadonlyArray<string>,
    operation: string,
    allowNonZeroExit = false,
  ) =>
    vcsProcess.execute({
      operation,
      command: "jj",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

  const readCurrentJjBaseBookmarks = (cwd: string) =>
    runJj(
      cwd,
      ["log", "-r", "heads(::@ & bookmarks())", "--no-graph", "-T", 'json(local_bookmarks) ++ "\\n"'],
      "VcsCore.readCurrentJjBaseBookmarks",
    ).pipe(
      Effect.map((result) => {
        const bookmarkRows = parseJsonLines<Array<JjLocalBookmark>>(result.stdout);
        return [...new Set(
          bookmarkRows
            .flatMap((row) => row)
            .map((bookmark) => bookmark.name?.trim() ?? "")
            .filter((bookmarkName) => bookmarkName.length > 0),
        )].toSorted((a, b) => a.localeCompare(b));
      }),
    );

  const status: VcsCoreShape["status"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const statusResult = yield* gitManager.status({ cwd: input.cwd }).pipe(
          Effect.mapError(
            toVcsServiceError({
              operation: "VcsCore.status",
              cwd: input.cwd,
              command: "git status",
            }),
          ),
        );
        return toGitVcsStatus({
          status: statusResult,
          capabilities: resolution.capabilities,
        });
      }

      const [gitStatus, currentBaseBookmarks] = yield* Effect.all(
        [
          gitCore.status({ cwd: input.cwd }).pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.status",
                cwd: input.cwd,
                command: "git status",
              }),
            ),
          ),
          readCurrentJjBaseBookmarks(input.cwd),
        ],
        { concurrency: "unbounded" },
      );
      const currentBookmark = currentBaseBookmarks[0] ?? null;
      return {
        backend: "jj",
        capabilities: resolution.capabilities,
        refName: currentBookmark,
        refKind: currentBookmark ? "bookmark" : null,
        hasWorkingTreeChanges: gitStatus.hasWorkingTreeChanges,
        workingTree: gitStatus.workingTree,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      };
    });

  const listRefs: VcsCoreShape["listRefs"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitCore.listBranches({ cwd: input.cwd }).pipe(
          Effect.mapError(
            toVcsServiceError({
              operation: "VcsCore.listRefs",
              cwd: input.cwd,
              command: "git branch",
            }),
          ),
        );
        return {
          backend: "git",
          capabilities: resolution.capabilities,
          refs: result.branches.map(
            (branch) =>
              ({
                name: branch.name,
                kind: branch.isRemote ? "remoteBranch" : "branch",
                current: branch.current,
                isDefault: branch.isDefault,
                ...(branch.remoteName ? { remoteName: branch.remoteName } : {}),
                workspacePath: branch.worktreePath,
              }) satisfies VcsRef,
          ),
          isRepo: result.isRepo,
        } satisfies VcsListRefsResult;
      }

      const [bookmarkResult, currentBaseBookmarks] = yield* Effect.all(
        [
          runJj(
            input.cwd,
            ["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"'],
            "VcsCore.listRefs.bookmarks",
          ),
          readCurrentJjBaseBookmarks(input.cwd),
        ],
        { concurrency: "unbounded" },
      );
      const currentBaseBookmarkSet = new Set(currentBaseBookmarks);
      const refs = parseJsonLines<JjBookmarkRow>(bookmarkResult.stdout)
        .flatMap((bookmark) => {
          const name = bookmark.name?.trim();
          if (!name) return [];
          const remoteName = bookmark.remote?.trim();
          const refName = remoteName ? `${name}@${remoteName}` : name;
          return [
            {
              name: refName,
              kind: remoteName ? "remoteBookmark" : "bookmark",
              current: !remoteName && currentBaseBookmarkSet.has(name),
              isDefault: name === "main" || name === "master",
              ...(remoteName ? { remoteName } : {}),
              workspacePath: null,
            } satisfies VcsRef,
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));

      return {
        backend: "jj",
        capabilities: resolution.capabilities,
        refs,
        isRepo: true,
      } satisfies VcsListRefsResult;
    });

  const createWorkspace: VcsCoreShape["createWorkspace"] = (input: VcsCreateWorkspaceInput) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        const result = yield* gitCore
          .createWorktree({
            cwd: input.cwd,
            branch: input.refName,
            newBranch: input.newRefName ?? input.refName,
            path: input.path ?? null,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.createWorkspace",
                cwd: input.cwd,
                command: "git worktree add",
              }),
            ),
          );
        return {
          backend: "git",
          workspace: {
            path: result.worktree.path,
            refName: result.worktree.branch,
            refKind: "branch",
          },
        };
      }

      const repoName = path.basename(resolution.workspaceRoot);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const workspacePath =
        input.path ??
        path.join(homeDir, ".t3", "workspaces", repoName, sanitizeWorkspaceFragment(input.refName));
      const workspaceName = path.basename(workspacePath);
      yield* Effect.tryPromise({
        try: () => mkdir(path.dirname(workspacePath), { recursive: true }),
        catch: (error) =>
          new VcsCommandError({
            operation: "VcsCore.createWorkspace",
            command: "mkdir",
            cwd: input.cwd,
            detail:
              error instanceof Error
                ? error.message
                : "Failed to prepare jj workspace parent directory.",
            ...(error !== undefined ? { cause: error } : {}),
          }),
      });
      yield* runJj(
        input.cwd,
        [
          "workspace",
          "add",
          "--name",
          workspaceName,
          "--revision",
          buildJjRevision(input.refName, input.refKind),
          workspacePath,
        ],
        "VcsCore.createWorkspace",
      );
      return {
        backend: "jj",
        workspace: {
          path: workspacePath,
          refName: input.refName,
          refKind: input.refKind,
        },
      };
    });

  const removeWorkspace: VcsCoreShape["removeWorkspace"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .removeWorktree({
            cwd: input.cwd,
            path: input.path,
            ...(input.force !== undefined ? { force: input.force } : {}),
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.removeWorkspace",
                cwd: input.cwd,
                command: "git worktree remove",
              }),
            ),
          );
      }

      const workspaceName = path.basename(input.path);
      yield* runJj(
        input.cwd,
        ["workspace", "forget", workspaceName],
        "VcsCore.removeWorkspace",
      ).pipe(
        Effect.catch((error) => {
          const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          return detail.includes("no such file or directory") || detail.includes("no such workspace")
            ? Effect.void
            : Effect.fail(error);
        }),
      );
      yield* Effect.tryPromise({
        try: () =>
          rm(input.path, {
            recursive: true,
            force: input.force ?? true,
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
    });

  const createRef: VcsCoreShape["createRef"] = (input) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .createBranch({
            cwd: input.cwd,
            branch: input.refName,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.createRef",
                cwd: input.cwd,
                command: "git branch",
              }),
            ),
          );
      }
      return yield* new VcsUnsupportedError({
        operation: "VcsCore.createRef",
        cwd: input.cwd,
        detail: "Creating jj bookmarks is not enabled in v1.",
      });
    });

  const checkoutRef: VcsCoreShape["checkoutRef"] = (input: VcsCheckoutRefInput) =>
    Effect.gen(function* () {
      const resolution = yield* resolve(input);
      if (resolution.backend === "git") {
        return yield* gitCore
          .checkoutBranch({
            cwd: input.cwd,
            branch: input.refName,
          })
          .pipe(
            Effect.mapError(
              toVcsServiceError({
                operation: "VcsCore.checkoutRef",
                cwd: input.cwd,
                command: "git checkout",
              }),
            ),
          );
      }
      return yield* new VcsUnsupportedError({
        operation: "VcsCore.checkoutRef",
        cwd: input.cwd,
        detail: "Checking out jj bookmarks is not enabled in v1.",
      });
    });

  const init: VcsCoreShape["init"] = (input) =>
    Effect.gen(function* () {
      if (input.backend === "jj") {
        yield* vcsProcess.execute({
          operation: "VcsCore.init",
          command: "jj",
          cwd: input.cwd,
          args: ["git", "init", "--colocate", "."],
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        return;
      }
      return yield* gitCore.initRepo({ cwd: input.cwd }).pipe(
        Effect.mapError(
          toVcsServiceError({
            operation: "VcsCore.init",
            cwd: input.cwd,
            command: "git init",
          }),
        ),
      );
    });

  return {
    status,
    listRefs,
    createWorkspace,
    removeWorkspace,
    createRef,
    checkoutRef,
    init,
  } satisfies VcsCoreShape;
});

export const VcsCoreLive = Layer.effect(VcsCore, makeVcsCore);
