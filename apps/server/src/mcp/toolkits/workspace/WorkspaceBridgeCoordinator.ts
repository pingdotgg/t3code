/**
 * WorkspaceBridgeCoordinator — backs the read-only `workspace_*` MCP tools.
 *
 * This is the half of the ChatGPT web bridge that carries repository truth. A
 * chatgpt.com conversation registered as a Developer Mode connector calls
 * these tools; OpenAI's backend dials the endpoint, we resolve the credential
 * to one SergeCode thread, and every answer is scoped to that thread's
 * worktree.
 *
 * Three properties hold for every operation here:
 *
 *   - **Scope comes from the credential, never the caller.** The worktree is
 *     resolved from the thread the token was minted for. No tool accepts a
 *     root, so a remote model cannot widen its own reach by asking nicely.
 *   - **Reads only.** There is no write, patch, or command tool. The endpoint
 *     is reachable from the public internet by construction (that is the only
 *     way ChatGPT can call it), so the blast radius of a leaked token is
 *     capped at "read the files this thread could already show you".
 *   - **Every answer is bounded.** Byte, entry, and match caps are applied
 *     before results are built, and the cap that fired is reported, so a large
 *     repository yields a truncated answer instead of a stalled request.
 *
 * Each call also appends a `tool`-toned activity to the thread, which is what
 * makes the integration feel native rather than out-of-band: work ChatGPT does
 * against the repo shows up in the SergeCode timeline as it happens, next to
 * the prose the browser adapter scrapes back.
 *
 * @module mcp/toolkits/workspace/WorkspaceBridgeCoordinator
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  WorkspaceBridgeError,
  type WorkspaceChangedFile,
  type WorkspaceChangesInput,
  type WorkspaceChangesResult,
  type WorkspaceOverviewResult,
  type WorkspaceReadInput,
  type WorkspaceReadResult,
  type WorkspaceSearchInput,
  type WorkspaceSearchMatch,
  type WorkspaceSearchResult,
  type WorkspaceTreeEntry,
  type WorkspaceTreeInput,
  type WorkspaceTreeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../../../processRunner.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { BLOCKED_PATH_SEGMENTS, describeRejection, resolveWithin } from "./WorkspacePathGuard.ts";

/** Largest slice of a single file returned to the caller. */
const MAX_READ_BYTES = 180_000;
/** Largest diff body returned by `workspace_changes`. */
const MAX_DIFF_BYTES = 120_000;
/** Files scanned by one `workspace_search` call before it gives up walking. */
const MAX_SEARCH_FILES = 4_000;
/** Files larger than this are skipped by search — they are data, not source. */
const MAX_SEARCHABLE_FILE_BYTES = 2_000_000;
/** Longest single match line echoed back, so minified files cannot flood. */
const MAX_MATCH_LINE_LENGTH = 400;
const GIT_TIMEOUT = "10 seconds";

const DEFAULT_TREE_DEPTH = 3;
const DEFAULT_TREE_ENTRIES = 400;
const DEFAULT_SEARCH_RESULTS = 100;

/** Root files that tell an agent how this repository expects to be worked on. */
const INSTRUCTION_FILE_NAMES: ReadonlyArray<string> = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
];

export interface WorkspaceBridgeCoordinatorShape {
  readonly overview: (
    scope: McpInvocationScope,
  ) => Effect.Effect<WorkspaceOverviewResult, WorkspaceBridgeError>;
  readonly tree: (
    scope: McpInvocationScope,
    input: WorkspaceTreeInput,
  ) => Effect.Effect<WorkspaceTreeResult, WorkspaceBridgeError>;
  readonly read: (
    scope: McpInvocationScope,
    input: WorkspaceReadInput,
  ) => Effect.Effect<WorkspaceReadResult, WorkspaceBridgeError>;
  readonly search: (
    scope: McpInvocationScope,
    input: WorkspaceSearchInput,
  ) => Effect.Effect<WorkspaceSearchResult, WorkspaceBridgeError>;
  readonly changes: (
    scope: McpInvocationScope,
    input: WorkspaceChangesInput,
  ) => Effect.Effect<WorkspaceChangesResult, WorkspaceBridgeError>;
}

export class WorkspaceBridgeCoordinator extends Context.Service<
  WorkspaceBridgeCoordinator,
  WorkspaceBridgeCoordinatorShape
>()("t3/mcp/toolkits/workspace/WorkspaceBridgeCoordinator") {}

const notFound = (path: string) =>
  new WorkspaceBridgeError({
    reason: "not-found",
    description: `No such path in this workspace: ${path}`,
  });

/**
 * Splits on any newline convention and drops a single trailing empty element,
 * so a file ending in a newline does not report a phantom final line.
 */
export const splitLines = (content: string): ReadonlyArray<string> => {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * Renders a file slice with 1-based line numbers so follow-up requests and
 * review comments can cite lines that match what the user sees in the editor.
 */
export const formatNumberedSlice = (lines: ReadonlyArray<string>, startLine: number): string => {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")}\t${line}`)
    .join("\n");
};

/**
 * Case-insensitive unless the query carries an uppercase character — the
 * "smart case" convention every developer already has muscle memory for from
 * ripgrep, so the model does not need a case flag it would guess wrong.
 */
export const matchesQuery = (line: string, query: string): boolean =>
  /[A-Z]/.test(query) ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase());

/** Parses `git status --porcelain=v1` into changed-file rows. */
export const parseGitStatus = (stdout: string): ReadonlyArray<WorkspaceChangedFile> =>
  splitLines(stdout)
    .filter((line) => line.length > 3)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      const rest = line.slice(3);
      // Renames arrive as "old -> new"; the destination is what the caller
      // can actually read, so that is what is reported.
      const arrow = rest.indexOf(" -> ");
      const path = arrow === -1 ? rest : rest.slice(arrow + 4);
      return { path, status: status.length > 0 ? status : "?" };
    })
    .filter((entry) => entry.path.length > 0);

const truncateUtf8 = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  const slice = encoded.subarray(0, maxBytes);
  // `fatal: false` drops a partial trailing code point rather than throwing,
  // which is exactly the behaviour a byte cap needs.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(slice), truncated: true };
};

const make = Effect.fn("WorkspaceBridgeCoordinator.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner;

  /**
   * Canonicalises the workspace root before anything is compared against it.
   *
   * Containment checks compare a file's *real* path to the root, so the root
   * has to live in the same space. It usually does not: macOS puts temp and
   * user directories behind symlinks (`/var` → `/private/var`), and developers
   * symlink checkouts routinely. Skipping this makes every read in such a
   * workspace look like a symlink escape.
   */
  const realWorkspaceRoot = (root: string) =>
    fs.realPath(NodePath.resolve(root)).pipe(Effect.orElseSucceed(() => NodePath.resolve(root)));

  /**
   * Resolves the credential's thread to a worktree on disk.
   *
   * `worktreePath` wins over the project root because a thread working in a
   * git worktree must see that worktree's files, not the main checkout's.
   */
  const requireWorkspaceRoot = Effect.fn("WorkspaceBridgeCoordinator.requireWorkspaceRoot")(
    function* (scope: McpInvocationScope) {
      const shell = yield* snapshotQuery.getThreadShellById(scope.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBridgeError({
              reason: "workspace-unavailable",
              description: `Could not read the thread behind this connector: ${cause.message}`,
            }),
        ),
      );
      if (Option.isNone(shell)) {
        return yield* new WorkspaceBridgeError({
          reason: "thread-not-found",
          description:
            "The SergeCode thread this connector was issued for no longer exists. Create a new ChatGPT thread to get a fresh connector URL.",
        });
      }

      // A thread working in a git worktree must see that worktree's files,
      // not the project's main checkout — otherwise ChatGPT reads a different
      // branch than the one the user is looking at. Only fall back to the
      // project root when the thread has no worktree of its own.
      const worktreePath = shell.value.worktreePath;
      if (worktreePath !== null && worktreePath.trim().length > 0) {
        return yield* realWorkspaceRoot(worktreePath);
      }

      const project = yield* snapshotQuery.getProjectShellById(shell.value.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBridgeError({
              reason: "workspace-unavailable",
              description: `Could not read the project behind this connector: ${cause.message}`,
            }),
        ),
      );
      if (Option.isNone(project) || project.value.workspaceRoot.trim().length === 0) {
        return yield* new WorkspaceBridgeError({
          reason: "workspace-unavailable",
          description: "This thread has no workspace on disk.",
        });
      }
      return yield* realWorkspaceRoot(project.value.workspaceRoot);
    },
  );

  /** Applies the path guard, consulting the real path so symlinks cannot escape. */
  const guardPath = Effect.fn("WorkspaceBridgeCoordinator.guardPath")(function* (input: {
    readonly root: string;
    readonly requestedPath: string;
  }) {
    const provisional = resolveWithin({ root: input.root, requestedPath: input.requestedPath });
    if (!provisional.ok) {
      return yield* new WorkspaceBridgeError({
        reason: "path-not-allowed",
        description: describeRejection(provisional.rejection),
      });
    }
    // Only a path that already passed containment is realised, so realpath is
    // never called on an attacker-chosen location outside the workspace.
    const realPath = yield* fs
      .realPath(provisional.absolutePath)
      .pipe(Effect.orElseSucceed(() => provisional.absolutePath));
    const confirmed = resolveWithin({
      root: input.root,
      requestedPath: input.requestedPath,
      realPath,
    });
    if (!confirmed.ok) {
      return yield* new WorkspaceBridgeError({
        reason: "path-not-allowed",
        description: describeRejection(confirmed.rejection),
      });
    }
    return confirmed;
  });

  const runGit = (root: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args, cwd: root, timeout: GIT_TIMEOUT, outputMode: "truncate" })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );

  /**
   * Mirrors one bridge call into the thread timeline.
   *
   * Failures are swallowed: the timeline is an observability surface, and a
   * projection hiccup must not turn a successful file read into a tool error
   * for the remote model.
   */
  const recordActivity = (input: {
    readonly scope: McpInvocationScope;
    readonly tool: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `server:chatgpt-bridge:${input.scope.providerSessionId}:${input.tool}:${createdAt}`,
        ),
        threadId: input.scope.threadId,
        createdAt,
        activity: {
          id: EventId.make(
            `chatgpt-bridge:${input.scope.providerSessionId}:${input.tool}:${createdAt}`,
          ),
          tone: "tool",
          kind: `tool.chatgpt-bridge.${input.tool}`,
          summary: input.summary,
          payload: { ...input.payload, source: "chatgpt-web-connector" },
          turnId: null,
          createdAt,
        },
      });
    }).pipe(Effect.ignore);

  const overview: WorkspaceBridgeCoordinatorShape["overview"] = Effect.fn(
    "WorkspaceBridgeCoordinator.overview",
  )(function* (scope) {
    const root = yield* requireWorkspaceRoot(scope);
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const visible = names
      .filter((name) => !BLOCKED_PATH_SEGMENTS.has(name))
      .sort((left, right) => left.localeCompare(right));
    const branch = yield* runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = yield* runGit(root, ["status", "--porcelain=v1"]);

    yield* recordActivity({
      scope,
      tool: "overview",
      summary: "ChatGPT inspected the workspace",
      payload: { entries: visible.length },
    });

    return {
      root,
      name: NodePath.basename(root),
      branch: branch === null ? null : branch.trim(),
      dirty: status !== null && status.trim().length > 0,
      entries: visible,
      instructionFiles: INSTRUCTION_FILE_NAMES.filter((name) => visible.includes(name)),
      readOnly: true,
    };
  });

  const tree: WorkspaceBridgeCoordinatorShape["tree"] = Effect.fn(
    "WorkspaceBridgeCoordinator.tree",
  )(function* (scope, input) {
    const root = yield* requireWorkspaceRoot(scope);
    const guarded = yield* guardPath({ root, requestedPath: input.path ?? "." });
    const maxDepth = input.maxDepth ?? DEFAULT_TREE_DEPTH;
    const maxEntries = input.maxEntries ?? DEFAULT_TREE_ENTRIES;

    const collected: Array<WorkspaceTreeEntry> = [];
    let truncated = false;

    const walk = (absolute: string, relative: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > maxDepth || truncated) return;
        const names = yield* fs.readDirectory(absolute).pipe(Effect.orElseSucceed(() => []));
        for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
          if (truncated) return;
          const childRelative = relative === "." ? name : `${relative}/${name}`;
          const childGuard = resolveWithin({ root, requestedPath: childRelative });
          if (!childGuard.ok) continue;
          const info = yield* fs.stat(childGuard.absolutePath).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          const isDirectory = info.value.type === "Directory";
          if (collected.length >= maxEntries) {
            truncated = true;
            return;
          }
          collected.push({ path: childRelative, kind: isDirectory ? "directory" : "file" });
          if (isDirectory) yield* walk(childGuard.absolutePath, childRelative, depth + 1);
        }
      });

    const info = yield* fs.stat(guarded.absolutePath).pipe(Effect.option);
    if (Option.isNone(info)) return yield* notFound(guarded.relativePath);
    if (info.value.type !== "Directory") {
      return yield* new WorkspaceBridgeError({
        reason: "not-a-directory",
        description: `${guarded.relativePath} is a file. Use workspace_read for files.`,
      });
    }

    yield* walk(guarded.absolutePath, guarded.relativePath, 1);
    yield* recordActivity({
      scope,
      tool: "tree",
      summary: `ChatGPT listed ${guarded.relativePath}`,
      payload: { path: guarded.relativePath, entries: collected.length, truncated },
    });

    return { entries: collected, truncated };
  });

  const read: WorkspaceBridgeCoordinatorShape["read"] = Effect.fn(
    "WorkspaceBridgeCoordinator.read",
  )(function* (scope, input) {
    const root = yield* requireWorkspaceRoot(scope);
    const guarded = yield* guardPath({ root, requestedPath: input.path });

    const info = yield* fs.stat(guarded.absolutePath).pipe(Effect.option);
    if (Option.isNone(info)) return yield* notFound(guarded.relativePath);
    if (info.value.type === "Directory") {
      return yield* new WorkspaceBridgeError({
        reason: "not-a-file",
        description: `${guarded.relativePath} is a directory. Use workspace_tree to list it.`,
      });
    }

    const raw = yield* fs.readFileString(guarded.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBridgeError({
            reason: "read-failed",
            description: `Could not read ${guarded.relativePath}: ${cause.message}`,
          }),
      ),
    );

    const allLines = splitLines(raw);
    const startLine = Math.min(Math.max(input.startLine ?? 1, 1), Math.max(allLines.length, 1));
    const endLine = Math.min(input.endLine ?? allLines.length, allLines.length);
    const slice = endLine < startLine ? [] : allLines.slice(startLine - 1, endLine);
    const rendered = formatNumberedSlice(slice, startLine);
    const capped = truncateUtf8(rendered, MAX_READ_BYTES);

    yield* recordActivity({
      scope,
      tool: "read",
      summary: `ChatGPT read ${guarded.relativePath}`,
      payload: {
        path: guarded.relativePath,
        startLine,
        endLine,
        truncated: capped.truncated,
      },
    });

    return {
      path: guarded.relativePath,
      content: capped.text,
      startLine,
      endLine,
      totalLines: allLines.length,
      truncated: capped.truncated,
    };
  });

  const search: WorkspaceBridgeCoordinatorShape["search"] = Effect.fn(
    "WorkspaceBridgeCoordinator.search",
  )(function* (scope, input) {
    const root = yield* requireWorkspaceRoot(scope);
    const guarded = yield* guardPath({ root, requestedPath: input.path ?? "." });
    const maxResults = input.maxResults ?? DEFAULT_SEARCH_RESULTS;

    const matches: Array<WorkspaceSearchMatch> = [];
    let filesScanned = 0;
    let truncated = false;

    const walk = (absolute: string, relative: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (truncated || filesScanned >= MAX_SEARCH_FILES) return;
        const names = yield* fs.readDirectory(absolute).pipe(Effect.orElseSucceed(() => []));
        for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
          if (truncated || filesScanned >= MAX_SEARCH_FILES) return;
          const childRelative = relative === "." ? name : `${relative}/${name}`;
          const childGuard = resolveWithin({ root, requestedPath: childRelative });
          if (!childGuard.ok) continue;
          const info = yield* fs.stat(childGuard.absolutePath).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") {
            yield* walk(childGuard.absolutePath, childRelative);
            continue;
          }
          if (info.value.type !== "File") continue;
          if (Number(info.value.size) > MAX_SEARCHABLE_FILE_BYTES) continue;
          filesScanned += 1;
          const content = yield* fs
            .readFileString(childGuard.absolutePath)
            .pipe(Effect.orElseSucceed(() => ""));
          const lines = splitLines(content);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!matchesQuery(line, input.query)) continue;
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
            matches.push({
              path: childRelative,
              line: index + 1,
              text: line.slice(0, MAX_MATCH_LINE_LENGTH).trim(),
            });
          }
        }
      });

    yield* walk(guarded.absolutePath, guarded.relativePath);
    yield* recordActivity({
      scope,
      tool: "search",
      summary: `ChatGPT searched for "${input.query}"`,
      payload: { query: input.query, matches: matches.length, truncated },
    });

    return { matches, truncated };
  });

  const changes: WorkspaceBridgeCoordinatorShape["changes"] = Effect.fn(
    "WorkspaceBridgeCoordinator.changes",
  )(function* (scope, input) {
    const root = yield* requireWorkspaceRoot(scope);
    const statusOutput = yield* runGit(root, ["status", "--porcelain=v1"]);
    if (statusOutput === null) {
      return yield* new WorkspaceBridgeError({
        reason: "git-unavailable",
        description: "This workspace is not a git repository, or git is not available.",
      });
    }

    const branch = yield* runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const files = parseGitStatus(statusOutput);
    const includeDiff = input.includeDiff ?? true;
    const diffArgs = input.staged === true ? ["diff", "--staged"] : ["diff"];
    const rawDiff = includeDiff ? ((yield* runGit(root, diffArgs)) ?? "") : "";
    const capped = truncateUtf8(rawDiff, MAX_DIFF_BYTES);

    yield* recordActivity({
      scope,
      tool: "changes",
      summary: `ChatGPT reviewed ${files.length} changed file${files.length === 1 ? "" : "s"}`,
      payload: { files: files.length, staged: input.staged === true },
    });

    return {
      branch: branch === null ? null : branch.trim(),
      files,
      diff: capped.text,
      truncated: capped.truncated,
    };
  });

  return WorkspaceBridgeCoordinator.of({ overview, tree, read, search, changes });
});

/**
 * `ProcessRunner` is provided here rather than left in the layer's
 * requirements: the MCP transport is assembled in several places (server
 * runtime, tests), and a toolkit that silently widened everyone's context
 * would break those call sites for a dependency only `workspace_changes`
 * needs. `ChildProcessSpawner` remains outstanding, which every runtime that
 * can host this server already provides.
 */
export const WorkspaceBridgeCoordinatorLive = Layer.effect(WorkspaceBridgeCoordinator, make()).pipe(
  Layer.provide(ProcessRunnerLive),
);
