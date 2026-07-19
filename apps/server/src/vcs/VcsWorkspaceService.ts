import * as NodeCrypto from "node:crypto";

import {
  VcsWorkflowError,
  type ThreadId,
  type VcsDriverKind,
  type VcsNamedRef,
  type VcsRevision,
  type VcsWorkspaceIdentity,
} from "@t3tools/contracts";
import {
  JJ_REVISION_JSON_TEMPLATE,
  JJ_WORKSPACE_JSON_TEMPLATE,
  isJjRevisionRecord,
  isJjWorkspaceRecord,
  parseJjJsonLines,
  quoteJjSymbol,
  type JjRevisionRecord,
  type JjWorkspaceRecord,
} from "@t3tools/shared/jjCli";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export interface CreateThreadWorkspaceInput {
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly baseRevision: string;
  readonly baseRefName?: string;
  readonly publishRef?: string;
  readonly startFromOrigin?: boolean;
  readonly path?: string;
}

export interface EnsureThreadWorkspaceInput {
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly workspace: VcsWorkspaceIdentity;
}

export interface RemoveThreadWorkspaceInput {
  readonly cwd: string;
  readonly workspace: VcsWorkspaceIdentity;
}

export class VcsWorkspaceService extends Context.Service<
  VcsWorkspaceService,
  {
    readonly createThreadWorkspace: (
      input: CreateThreadWorkspaceInput,
    ) => Effect.Effect<VcsWorkspaceIdentity, VcsWorkflowError>;
    readonly ensureThreadWorkspace: (
      input: EnsureThreadWorkspaceInput,
    ) => Effect.Effect<VcsWorkspaceIdentity, VcsWorkflowError>;
    readonly removeThreadWorkspace: (
      input: RemoveThreadWorkspaceInput,
    ) => Effect.Effect<void, VcsWorkflowError>;
  }
>()("t3/vcs/VcsWorkspaceService") {}

export function jjWorkspaceNameForThread(threadId: ThreadId): string {
  const digest = NodeCrypto.createHash("sha256").update(threadId, "utf8").digest("hex");
  return `t3code-${digest.slice(0, 20)}`;
}

function workspaceError(input: {
  readonly operation: string;
  readonly kind: VcsDriverKind;
  readonly detail: string;
  readonly recoverable?: boolean;
}): VcsWorkflowError {
  return new VcsWorkflowError({
    workflow: "workspace",
    operation: input.operation,
    kind: input.kind,
    detail: input.detail,
    recoverable: input.recoverable ?? false,
  });
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
}

function parseSingleRevision(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}): Effect.Effect<JjRevisionRecord, VcsWorkflowError> {
  return Effect.try({
    try: () => {
      if (input.stdoutTruncated) {
        throw new Error("jj returned truncated revision metadata.");
      }
      const records = parseJjJsonLines(input.stdout);
      if (records.length !== 1 || !isJjRevisionRecord(records[0])) {
        throw new Error("jj returned invalid revision metadata.");
      }
      return records[0];
    },
    catch: (cause) =>
      workspaceError({
        operation: input.operation,
        kind: "jj",
        detail: `${errorDetail(cause)} (${input.cwd})`,
      }),
  });
}

function parseWorkspaces(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}): Effect.Effect<ReadonlyArray<JjWorkspaceRecord>, VcsWorkflowError> {
  return Effect.try({
    try: () => {
      if (input.stdoutTruncated) {
        throw new Error("jj returned truncated workspace metadata.");
      }
      const records = parseJjJsonLines(input.stdout);
      if (!records.every(isJjWorkspaceRecord)) {
        throw new Error("jj returned invalid workspace metadata.");
      }
      return records;
    },
    catch: (cause) =>
      workspaceError({
        operation: input.operation,
        kind: "jj",
        detail: `${errorDetail(cause)} (${input.cwd})`,
      }),
  });
}

function currentWorkspaceName(revision: JjRevisionRecord): string | null {
  for (const value of revision.workingCopies) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return null;
}

function toRevision(record: JjRevisionRecord): VcsRevision {
  return { commitId: record.commitId, changeId: record.changeId };
}

function sameRevision(left: VcsRevision | null | undefined, right: VcsRevision | null): boolean {
  return left?.commitId === right?.commitId && left?.changeId === right?.changeId;
}

const isVcsWorkflowError = Schema.is(VcsWorkflowError);

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const readJjRevision = Effect.fn("VcsWorkspaceService.readJjRevision")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    revision: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsWorkspaceService.readJjRevision",
      cwd,
      args: ["log", "--no-graph", "--revisions", revision, "--template", JJ_REVISION_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      appendTruncationMarker: false,
    });
    return yield* parseSingleRevision({
      operation: "read-revision",
      cwd,
      stdout: result.stdout,
      stdoutTruncated: result.stdoutTruncated,
    });
  });

  const listJjWorkspaces = Effect.fn("VcsWorkspaceService.listJjWorkspaces")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsWorkspaceService.listJjWorkspaces",
      cwd,
      args: ["workspace", "list", "--template", JJ_WORKSPACE_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: 512 * 1024,
      appendTruncationMarker: false,
    });
    return yield* parseWorkspaces({
      operation: "list-workspaces",
      cwd,
      stdout: result.stdout,
      stdoutTruncated: result.stdoutTruncated,
    });
  });

  const readCurrentJjRevision = Effect.fn("VcsWorkspaceService.readCurrentJjRevision")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    return yield* readJjRevision(driver, cwd, "@").pipe(
      Effect.catchTag("VcsProcessExitError", (cause) => {
        if (cause.failureKind !== "stale-workspace") {
          return Effect.fail(cause);
        }
        return Effect.logInfo("repairing stale Jujutsu thread workspace", { cwd }).pipe(
          Effect.andThen(
            driver.execute({
              operation: "VcsWorkspaceService.updateStale",
              cwd,
              args: ["workspace", "update-stale"],
              timeoutMs: 20_000,
              maxOutputBytes: 256 * 1024,
            }),
          ),
          Effect.andThen(readJjRevision(driver, cwd, "@")),
        );
      }),
    );
  });

  const jjIdentity = Effect.fn("VcsWorkspaceService.jjIdentity")(function* (input: {
    readonly driver: VcsDriver.VcsDriver["Service"];
    readonly cwd: string;
    readonly name: string;
    readonly workspacePath: string;
    readonly baseRevision?: VcsRevision | null;
    readonly publishRef?: string;
  }) {
    const revision = yield* readCurrentJjRevision(input.driver, input.workspacePath);
    const actualName = currentWorkspaceName(revision);
    if (actualName !== input.name) {
      return yield* workspaceError({
        operation: "validate-workspace",
        kind: "jj",
        detail: `Workspace path '${input.workspacePath}' belongs to '${actualName ?? "unknown"}', not '${input.name}'.`,
      });
    }
    const parentId = revision.parents[0];
    const actualBase = parentId
      ? toRevision(
          yield* readJjRevision(input.driver, input.workspacePath, quoteJjSymbol(parentId)),
        )
      : null;
    return {
      driverKind: "jj" as const,
      name: input.name,
      rootPath: input.workspacePath,
      workspaceRevision: toRevision(revision),
      baseRevision: input.baseRevision ?? actualBase,
      publishRef: input.publishRef
        ? ({ kind: "bookmark", name: input.publishRef } satisfies VcsNamedRef)
        : null,
    } satisfies VcsWorkspaceIdentity;
  });

  const createJjWorkspace = Effect.fn("VcsWorkspaceService.createJjWorkspace")(function* (
    input: CreateThreadWorkspaceInput,
    driver: VcsDriver.VcsDriver["Service"],
    repositoryRoot: string,
  ) {
    const name = jjWorkspaceNameForThread(input.threadId);
    const workspacePath =
      input.path ?? path.join(worktreesDir, path.basename(repositoryRoot), name);
    const base = yield* readJjRevision(driver, input.cwd, input.baseRevision);
    const pathExists = yield* fileSystem.exists(workspacePath);

    if (pathExists) {
      const existing = yield* readCurrentJjRevision(driver, workspacePath).pipe(Effect.option);
      if (existing._tag === "Some") {
        if (currentWorkspaceName(existing.value) !== name) {
          return yield* workspaceError({
            operation: "reuse-workspace",
            kind: "jj",
            detail: `Refusing to reuse '${workspacePath}' because it belongs to another workspace.`,
          });
        }
        return yield* jjIdentity({
          driver,
          cwd: input.cwd,
          name,
          workspacePath,
          ...(input.publishRef ? { publishRef: input.publishRef } : {}),
        });
      }

      const entries = yield* fileSystem.readDirectory(workspacePath);
      if (entries.length > 0) {
        return yield* workspaceError({
          operation: "reuse-workspace",
          kind: "jj",
          detail: `Refusing to replace non-empty workspace path '${workspacePath}'.`,
          recoverable: true,
        });
      }
      yield* fileSystem.remove(workspacePath, { recursive: true, force: true });
    }

    const workspaces = yield* listJjWorkspaces(driver, input.cwd);
    if (workspaces.some((workspace) => workspace.name === name)) {
      yield* Effect.logInfo("forgetting missing Jujutsu thread workspace before recreation", {
        cwd: input.cwd,
        workspaceName: name,
        workspacePath,
      });
      yield* driver.execute({
        operation: "VcsWorkspaceService.forgetMissing",
        cwd: input.cwd,
        args: ["workspace", "forget", name],
        timeoutMs: 10_000,
        maxOutputBytes: 256 * 1024,
      });
    }

    yield* fileSystem.makeDirectory(path.dirname(workspacePath), { recursive: true });
    yield* driver.execute({
      operation: "VcsWorkspaceService.createJjWorkspace",
      cwd: input.cwd,
      args: ["workspace", "add", workspacePath, "--name", name, "--revision", input.baseRevision],
      timeoutMs: 120_000,
      maxOutputBytes: 1_000_000,
    });

    const confirmed = yield* listJjWorkspaces(driver, input.cwd);
    if (!confirmed.some((workspace) => workspace.name === name)) {
      return yield* workspaceError({
        operation: "confirm-workspace",
        kind: "jj",
        detail: `Created workspace '${name}' was not present in jj workspace metadata.`,
        recoverable: true,
      });
    }

    return yield* jjIdentity({
      driver,
      cwd: input.cwd,
      name,
      workspacePath,
      baseRevision: toRevision(base),
      ...(input.publishRef ? { publishRef: input.publishRef } : {}),
    });
  });

  const createThreadWorkspace: VcsWorkspaceService["Service"]["createThreadWorkspace"] = Effect.fn(
    "VcsWorkspaceService.createThreadWorkspace",
  )(
    function* (input) {
      const handle = yield* registry.resolve({ cwd: input.cwd });
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": handle.kind,
        "vcs.workflow": "workspace",
        "vcs.operation": "create",
      });
      if (handle.kind === "jj") {
        return yield* createJjWorkspace(input, handle.driver, handle.repository.rootPath);
      }

      let baseRevision = input.baseRevision;
      if (input.startFromOrigin) {
        yield* gitWorkflow.fetchRemote({ cwd: input.cwd, remoteName: "origin" });
        const resolved = yield* gitWorkflow.resolveRemoteTrackingCommit({
          cwd: input.cwd,
          refName: input.baseRevision,
          fallbackRemoteName: "origin",
        });
        baseRevision = resolved.commitSha;
      }
      const created = yield* gitWorkflow.createWorktree({
        cwd: input.cwd,
        refName: baseRevision,
        ...(input.publishRef ? { newRefName: input.publishRef } : {}),
        ...(input.baseRefName ? { baseRefName: input.baseRefName } : {}),
        path: input.path ?? null,
      });
      const [current, base] = yield* Effect.all([
        handle.driver.execute({
          operation: "VcsWorkspaceService.readGitWorkspaceRevision",
          cwd: created.worktree.path,
          args: ["rev-parse", "--verify", "HEAD^{commit}"],
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
        }),
        handle.driver.execute({
          operation: "VcsWorkspaceService.readGitBaseRevision",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", `${baseRevision}^{commit}`],
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
        }),
      ]);
      const currentCommit = current.stdout.trim();
      const baseCommit = base.stdout.trim();
      if (currentCommit.length === 0 || baseCommit.length === 0) {
        return yield* workspaceError({
          operation: "read-git-workspace-identity",
          kind: "git",
          detail: "Git returned an empty workspace or base revision.",
        });
      }
      return {
        driverKind: "git",
        name: created.worktree.refName,
        rootPath: created.worktree.path,
        workspaceRevision: { commitId: currentCommit },
        baseRevision: { commitId: baseCommit },
        publishRef: {
          kind: "branch",
          name: created.worktree.refName,
          target: { commitId: currentCommit },
        },
      } satisfies VcsWorkspaceIdentity;
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : workspaceError({
            operation: "create-thread-workspace",
            kind: "unknown",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  const ensureThreadWorkspace: VcsWorkspaceService["Service"]["ensureThreadWorkspace"] = Effect.fn(
    "VcsWorkspaceService.ensureThreadWorkspace",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": input.workspace.driverKind,
        "vcs.workflow": "workspace",
        "vcs.operation": "ensure",
      });
      if (input.workspace.driverKind !== "jj") {
        return input.workspace;
      }
      const baseRevision = input.workspace.baseRevision?.commitId;
      if (!baseRevision) {
        return yield* workspaceError({
          operation: "ensure-thread-workspace",
          kind: "jj",
          detail: "Persisted Jujutsu workspace metadata has no base revision.",
          recoverable: true,
        });
      }
      const handle = yield* registry.resolve({ cwd: input.cwd, requestedKind: "jj" });
      const ensured = yield* createJjWorkspace(
        {
          cwd: input.cwd,
          threadId: input.threadId,
          baseRevision,
          ...(input.workspace.publishRef ? { publishRef: input.workspace.publishRef.name } : {}),
          path: input.workspace.rootPath,
        },
        handle.driver,
        handle.repository.rootPath,
      );
      if (
        ensured.rootPath !== input.workspace.rootPath ||
        ensured.name !== input.workspace.name ||
        !sameRevision(ensured.workspaceRevision, input.workspace.workspaceRevision) ||
        !sameRevision(ensured.baseRevision, input.workspace.baseRevision)
      ) {
        yield* Effect.logInfo("refreshed persisted Jujutsu thread workspace identity", {
          threadId: input.threadId,
          workspaceName: ensured.name,
          workspacePath: ensured.rootPath,
        });
      }
      return ensured;
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : workspaceError({
            operation: "ensure-thread-workspace",
            kind: "jj",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  const removeThreadWorkspace: VcsWorkspaceService["Service"]["removeThreadWorkspace"] = Effect.fn(
    "VcsWorkspaceService.removeThreadWorkspace",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": input.workspace.driverKind,
        "vcs.workflow": "workspace",
        "vcs.operation": "remove",
      });
      if (input.workspace.driverKind === "git") {
        yield* gitWorkflow.removeWorktree({
          cwd: input.cwd,
          path: input.workspace.rootPath,
          force: true,
        });
        return;
      }
      const name = input.workspace.name;
      if (!name) {
        return yield* workspaceError({
          operation: "remove-thread-workspace",
          kind: "jj",
          detail: "Persisted Jujutsu workspace metadata has no workspace name.",
        });
      }
      const handle = yield* registry.resolve({ cwd: input.cwd, requestedKind: "jj" });
      const pathExists = yield* fileSystem.exists(input.workspace.rootPath);
      if (pathExists) {
        const revision = yield* readCurrentJjRevision(handle.driver, input.workspace.rootPath);
        if (currentWorkspaceName(revision) !== name) {
          return yield* workspaceError({
            operation: "remove-thread-workspace",
            kind: "jj",
            detail: `Refusing to delete '${input.workspace.rootPath}' because it belongs to another workspace.`,
          });
        }
      }
      const workspaces = yield* listJjWorkspaces(handle.driver, input.cwd);
      if (workspaces.some((workspace) => workspace.name === name)) {
        yield* handle.driver.execute({
          operation: "VcsWorkspaceService.forgetJjWorkspace",
          cwd: input.cwd,
          args: ["workspace", "forget", name],
          timeoutMs: 10_000,
          maxOutputBytes: 256 * 1024,
        });
      }
      if (pathExists) {
        yield* fileSystem.remove(input.workspace.rootPath, { recursive: true, force: true });
      }
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : workspaceError({
            operation: "remove-thread-workspace",
            kind: "unknown",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  return VcsWorkspaceService.of({
    createThreadWorkspace,
    ensureThreadWorkspace,
    removeThreadWorkspace,
  });
});

export const layer = Layer.effect(VcsWorkspaceService, make);
