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
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  WorkspaceBridgeError,
  type CanonicalRequestType,
  type RuntimeMode,
  type ThreadId,
  type WorkspaceBashInput,
  type WorkspaceBridgeAccess,
  type WorkspaceChangedFile,
  type WorkspaceChangesInput,
  type WorkspaceChangesResult,
  type WorkspaceEditInput,
  type WorkspaceMutationResult,
  type WorkspaceMutationTool,
  type WorkspaceOverviewResult,
  type WorkspacePatchInput,
  type WorkspaceReadInput,
  type WorkspaceReadResult,
  type WorkspaceSearchInput,
  type WorkspaceSearchMatch,
  type WorkspaceSearchResult,
  type WorkspaceTreeEntry,
  type WorkspaceTreeInput,
  type WorkspaceTreeResult,
  type WorkspaceWaitInput,
  type WorkspaceWriteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../../../processRunner.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { openWorkspaceApproval } from "./WorkspaceApprovalBroker.ts";
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

/** How long a mutating MCP call blocks hoping for a quick human decision. */
let initialApprovalWait: Duration.Input = "20 seconds";
const DEFAULT_WAIT_SECONDS = 20;
/** Staged-operation bookkeeping cap; completed records are pruned first. */
const MAX_TRACKED_OPERATIONS = 200;
const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_TIMEOUT_MS = 180_000;
/** Per-stream cap while the command runs. */
const MAX_BASH_OUTPUT_BYTES = 262_144;
/** Cap on the merged output echoed back to the model. */
const MAX_BASH_RESULT_BYTES = 32_000;
/** Cap on the detail body shown in an approval card. */
const MAX_APPROVAL_DETAIL_CHARS = 1_600;

const MUTATION_PAST_TENSE: Record<WorkspaceMutationTool, string> = {
  write: "wrote a file",
  edit: "edited a file",
  patch: "applied a patch",
  bash: "ran a command",
};

const truncateDetail = (detail: string): string =>
  detail.length <= MAX_APPROVAL_DETAIL_CHARS
    ? detail
    : `${detail.slice(0, MAX_APPROVAL_DETAIL_CHARS)}\n… (truncated)`;

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
  readonly write: (
    scope: McpInvocationScope,
    input: WorkspaceWriteInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceBridgeError>;
  readonly edit: (
    scope: McpInvocationScope,
    input: WorkspaceEditInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceBridgeError>;
  readonly patch: (
    scope: McpInvocationScope,
    input: WorkspacePatchInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceBridgeError>;
  readonly bash: (
    scope: McpInvocationScope,
    input: WorkspaceBashInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceBridgeError>;
  readonly wait: (
    scope: McpInvocationScope,
    input: WorkspaceWaitInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceBridgeError>;
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
  parseGitStatusEntries(stdout).map(({ file }) => file);

const parseGitStatusEntries = (
  stdout: string,
): ReadonlyArray<{
  readonly file: WorkspaceChangedFile;
  readonly paths: ReadonlyArray<string>;
}> =>
  splitLines(stdout)
    .filter((line) => line.length > 3)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      const rest = line.slice(3);
      // Renames carry both paths. Keep both for security filtering, while the
      // result still reports the destination the caller can actually read.
      const arrow = rest.indexOf(" -> ");
      const paths = arrow === -1 ? [rest] : [rest.slice(0, arrow), rest.slice(arrow + 4)];
      return {
        file: { path: paths[paths.length - 1] ?? "", status: status.length > 0 ? status : "?" },
        paths,
      };
    })
    .filter(({ file }) => file.path.length > 0);

/** Removes status rows that the workspace toolkit must never disclose. */
export const filterGitStatus = (
  root: string,
  stdout: string,
): ReadonlyArray<WorkspaceChangedFile> =>
  parseGitStatusEntries(stdout)
    .filter(({ paths }) => paths.every((path) => resolveWithin({ root, requestedPath: path }).ok))
    .map(({ file }) => file);

/** Suppresses patch content whenever any status row contains a blocked path. */
export const filterGitDiff = (root: string, statusOutput: string, rawDiff: string): string =>
  parseGitStatusEntries(statusOutput).some(({ paths }) =>
    paths.some((path) => !resolveWithin({ root, requestedPath: path }).ok),
  )
    ? ""
    : rawDiff;

/**
 * Whether a granted mutation still needs a human decision, given the thread's
 * runtime mode. This mirrors what the same modes mean for local providers:
 * `auto-accept-edits` and above auto-approve file changes, and only
 * `full-access` auto-approves commands.
 */
export const workspaceMutationNeedsApproval = (
  mode: RuntimeMode,
  tool: WorkspaceMutationTool,
): boolean => (tool === "bash" ? mode !== "full-access" : mode === "approval-required");

/**
 * Extracts the workspace-relative paths a unified diff touches, from the
 * `diff --git`, `---`/`+++`, and `rename` headers. Only `a/`-/`b/`-prefixed
 * paths are accepted — which is also why the caller refuses a patch that
 * yields no paths: a diff written with absolute paths or `--unsafe-paths`
 * conventions never gets as far as `git apply`.
 */
export const extractPatchPaths = (patch: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader) {
      paths.add(gitHeader[1] ?? "");
      paths.add(gitHeader[2] ?? "");
      continue;
    }
    const fileHeader = /^(?:---|\+\+\+) (?:a\/|b\/)(.+)$/.exec(line);
    if (fileHeader) {
      paths.add((fileHeader[1] ?? "").trim());
      continue;
    }
    const rename = /^rename (?:from|to) (.+)$/.exec(line);
    if (rename) {
      paths.add((rename[1] ?? "").trim());
    }
  }
  paths.delete("");
  return [...paths];
};

/** Derives the settings-level access from the capabilities in the credential. */
export const accessFromScope = (scope: McpInvocationScope): WorkspaceBridgeAccess =>
  scope.capabilities.has("workspace-bash")
    ? "full"
    : scope.capabilities.has("workspace-write")
      ? "write"
      : "read";

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
  // Executor fibers for approval-deferred mutations live in the coordinator's
  // own scope (the layer scope, i.e. server lifetime), so a mutation approved
  // after the MCP call returned still executes, and everything is interrupted
  // together on shutdown.
  const coordinatorScope = yield* Effect.scope;

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
   * Resolves the credential's thread to a worktree on disk plus the thread's
   * current runtime mode (the mode is what decides whether a mutation
   * auto-executes or goes through the approval card).
   *
   * `worktreePath` wins over the project root because a thread working in a
   * git worktree must see that worktree's files, not the main checkout's.
   */
  const requireThread = Effect.fn("WorkspaceBridgeCoordinator.requireThread")(function* (
    scope: McpInvocationScope,
  ) {
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
    const runtimeMode = shell.value.runtimeMode;

    // A thread working in a git worktree must see that worktree's files,
    // not the project's main checkout — otherwise ChatGPT reads a different
    // branch than the one the user is looking at. Only fall back to the
    // project root when the thread has no worktree of its own.
    const worktreePath = shell.value.worktreePath;
    if (worktreePath !== null && worktreePath.trim().length > 0) {
      return { root: yield* realWorkspaceRoot(worktreePath), runtimeMode };
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
    return { root: yield* realWorkspaceRoot(project.value.workspaceRoot), runtimeMode };
  });

  const requireWorkspaceRoot = (scope: McpInvocationScope) =>
    Effect.map(requireThread(scope), ({ root }) => root);

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

  /**
   * The write-side guard. Everything `guardPath` checks, plus the parent
   * directory's real path — a symlinked directory inside the worktree must
   * not become a portal for writing outside it, even when the target file
   * does not exist yet (so the file itself has no realpath to check).
   */
  const guardWritePath = Effect.fn("WorkspaceBridgeCoordinator.guardWritePath")(function* (input: {
    readonly root: string;
    readonly requestedPath: string;
  }) {
    const guarded = yield* guardPath(input);
    const parentReal = yield* fs
      .realPath(NodePath.dirname(guarded.absolutePath))
      .pipe(Effect.option);
    if (
      Option.isSome(parentReal) &&
      !resolveWithin({
        root: input.root,
        requestedPath: input.requestedPath,
        realPath: NodePath.join(parentReal.value, NodePath.basename(guarded.absolutePath)),
      }).ok
    ) {
      return yield* new WorkspaceBridgeError({
        reason: "path-not-allowed",
        description: describeRejection("symlink-escapes-workspace"),
      });
    }
    return guarded;
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
      readOnly: accessFromScope(scope) === "read",
      access: accessFromScope(scope),
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
          const lexicalChild = resolveWithin({ root, requestedPath: childRelative });
          if (!lexicalChild.ok) continue;
          const realChild = yield* fs.realPath(lexicalChild.absolutePath).pipe(Effect.option);
          if (Option.isNone(realChild)) continue;
          const childGuard = resolveWithin({
            root,
            requestedPath: childRelative,
            realPath: realChild.value,
          });
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
          const lexicalChild = resolveWithin({ root, requestedPath: childRelative });
          if (!lexicalChild.ok) continue;
          const realChild = yield* fs.realPath(lexicalChild.absolutePath).pipe(Effect.option);
          if (Option.isNone(realChild)) continue;
          const childGuard = resolveWithin({
            root,
            requestedPath: childRelative,
            realPath: realChild.value,
          });
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
    const files = filterGitStatus(root, statusOutput);
    const includeDiff = input.includeDiff ?? true;
    const diffArgs = input.staged === true ? ["diff", "--staged"] : ["diff"];
    const rawDiff = includeDiff
      ? filterGitDiff(root, statusOutput, (yield* runGit(root, diffArgs)) ?? "")
      : "";
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

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  interface OperationRecord {
    readonly operationId: string;
    readonly threadId: ThreadId;
    readonly tool: WorkspaceMutationTool;
    /** Latest observable state; replaced as the operation progresses. */
    snapshot: WorkspaceMutationResult;
    readonly done: Deferred.Deferred<WorkspaceMutationResult>;
  }

  const operations = new Map<string, OperationRecord>();

  const pruneOperations = () => {
    if (operations.size < MAX_TRACKED_OPERATIONS) return;
    for (const [operationId, record] of operations) {
      if (record.snapshot.status !== "pending-approval") {
        operations.delete(operationId);
        if (operations.size < MAX_TRACKED_OPERATIONS) return;
      }
    }
  };

  const finishOperation = (record: OperationRecord, result: WorkspaceMutationResult) =>
    Effect.gen(function* () {
      record.snapshot = result;
      yield* Deferred.succeed(record.done, result);
    });

  const requireCapability = (scope: McpInvocationScope, tool: WorkspaceMutationTool) => {
    const needed = tool === "bash" ? "workspace-bash" : "workspace-write";
    return scope.capabilities.has(needed)
      ? Effect.void
      : Effect.fail(
          new WorkspaceBridgeError({
            reason: "capability-unavailable",
            description: `This connector was issued without ${tool === "bash" ? "shell" : "write"} access. Raise "Workspace access" in SergeCode's ChatGPT provider settings and start a new thread.`,
          }),
        );
  };

  /**
   * Stages one mutation and applies the approval policy.
   *
   * The execute effect never reaches the error channel of the MCP call once
   * the operation is staged: an approved-but-failed operation (patch
   * rejected, command not found) resolves to a `failed` result with the
   * reason in the summary, identically whether it ran inline or after a
   * deferred approval. Only pre-staging rejections — capability, path guard,
   * malformed input — fail the call itself.
   */
  const stageMutation = Effect.fn("WorkspaceBridgeCoordinator.stageMutation")(function* (input: {
    readonly scope: McpInvocationScope;
    readonly tool: WorkspaceMutationTool;
    readonly runtimeMode: RuntimeMode;
    readonly requestType: CanonicalRequestType;
    readonly approvalDetail: string;
    readonly execute: Effect.Effect<
      Omit<WorkspaceMutationResult, "operationId" | "tool" | "status">,
      WorkspaceBridgeError
    >;
  }) {
    const { scope, tool } = input;
    pruneOperations();
    const operationId = `${tool}:${NodeCrypto.randomUUID()}`;
    const done = yield* Deferred.make<WorkspaceMutationResult>();
    const record: OperationRecord = {
      operationId,
      threadId: scope.threadId,
      tool,
      snapshot: {
        operationId,
        tool,
        status: "pending-approval",
        summary: "Waiting for the user to decide in SergeCode.",
      },
      done,
    };
    operations.set(operationId, record);

    const runExecute = Effect.gen(function* () {
      const outcome = yield* input.execute.pipe(
        Effect.map(
          (partial): WorkspaceMutationResult => ({
            operationId,
            tool,
            status: "completed",
            ...partial,
          }),
        ),
        Effect.catch((error: WorkspaceBridgeError) =>
          Effect.succeed<WorkspaceMutationResult>({
            operationId,
            tool,
            status: "failed",
            summary: error.message,
          }),
        ),
      );
      yield* finishOperation(record, outcome);
      yield* recordActivity({
        scope,
        tool,
        summary:
          outcome.status === "completed"
            ? `ChatGPT ${MUTATION_PAST_TENSE[tool]}: ${outcome.summary}`
            : `ChatGPT ${tool} failed: ${outcome.summary}`,
        payload: {
          operationId,
          status: outcome.status,
          ...(outcome.filesChanged ? { filesChanged: outcome.filesChanged } : {}),
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        },
      });
      return outcome;
    });

    if (!workspaceMutationNeedsApproval(input.runtimeMode, tool)) {
      return yield* runExecute;
    }

    const ticket = yield* openWorkspaceApproval({
      threadId: scope.threadId,
      requestType: input.requestType,
      detail: input.approvalDetail,
    });
    if (ticket === undefined) {
      operations.delete(operationId);
      return yield* new WorkspaceBridgeError({
        reason: "approval-unavailable",
        description:
          "This thread's runtime mode requires approval, but its ChatGPT session is not running in SergeCode, so there is no one to ask. Tell the user to keep the SergeCode thread open, or switch the thread's runtime mode.",
      });
    }
    if (ticket === "auto-accepted") {
      return yield* runExecute;
    }

    // The decision fiber outlives this MCP call on purpose: the write happens
    // the moment the user clicks approve, not when ChatGPT next polls.
    yield* Effect.gen(function* () {
      const decision = yield* ticket.decision;
      if (decision === "accept" || decision === "acceptForSession") {
        yield* runExecute;
        return;
      }
      yield* finishOperation(record, {
        operationId,
        tool,
        status: "denied",
        summary:
          decision === "decline"
            ? "The user declined this operation in SergeCode."
            : "The session ended before the user decided.",
      });
    }).pipe(Effect.forkIn(coordinatorScope));

    // Give a quick human decision the chance to produce a final answer in
    // this same MCP response; otherwise hand back the pending state for
    // workspace_wait to poll.
    const settled = yield* Deferred.await(done).pipe(Effect.timeoutOption(initialApprovalWait));
    if (Option.isSome(settled)) return settled.value;
    return {
      ...record.snapshot,
      summary:
        "Approval requested in the SergeCode timeline. Call workspace_wait with this operationId until it resolves.",
    };
  });

  const write: WorkspaceBridgeCoordinatorShape["write"] = Effect.fn(
    "WorkspaceBridgeCoordinator.write",
  )(function* (scope, input) {
    yield* requireCapability(scope, "write");
    const { root, runtimeMode } = yield* requireThread(scope);
    const guarded = yield* guardWritePath({ root, requestedPath: input.path });
    const existing = yield* fs.stat(guarded.absolutePath).pipe(Effect.option);
    if (Option.isSome(existing) && existing.value.type === "Directory") {
      return yield* new WorkspaceBridgeError({
        reason: "not-a-file",
        description: `${guarded.relativePath} is a directory.`,
      });
    }
    const bytes = new TextEncoder().encode(input.content).byteLength;
    const action = Option.isSome(existing) ? "Overwrite" : "Create";

    return yield* stageMutation({
      scope,
      tool: "write",
      runtimeMode,
      requestType: "file_change_approval",
      approvalDetail: truncateDetail(
        `ChatGPT wants to ${action.toLowerCase()} ${guarded.relativePath} (${bytes} bytes):\n\n${input.content}`,
      ),
      execute: Effect.gen(function* () {
        if (input.createDirs !== false) {
          yield* fs
            .makeDirectory(NodePath.dirname(guarded.absolutePath), { recursive: true })
            .pipe(Effect.ignore);
        }
        yield* fs.writeFileString(guarded.absolutePath, input.content).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceBridgeError({
                reason: "read-failed",
                description: `Could not write ${guarded.relativePath}: ${cause.message}`,
              }),
          ),
        );
        return {
          summary: `${action}d ${guarded.relativePath} (${bytes} bytes)`,
          filesChanged: [guarded.relativePath],
        };
      }),
    });
  });

  const edit: WorkspaceBridgeCoordinatorShape["edit"] = Effect.fn(
    "WorkspaceBridgeCoordinator.edit",
  )(function* (scope, input) {
    yield* requireCapability(scope, "edit");
    const { root, runtimeMode } = yield* requireThread(scope);
    const guarded = yield* guardWritePath({ root, requestedPath: input.path });

    return yield* stageMutation({
      scope,
      tool: "edit",
      runtimeMode,
      requestType: "file_change_approval",
      approvalDetail: truncateDetail(
        `ChatGPT wants to edit ${guarded.relativePath}:\n\n--- remove\n${input.oldText}\n+++ insert\n${input.newText}`,
      ),
      execute: Effect.gen(function* () {
        const current = yield* fs.readFileString(guarded.absolutePath).pipe(
          Effect.mapError(
            () =>
              new WorkspaceBridgeError({
                reason: "not-found",
                description: `No such file: ${guarded.relativePath}`,
              }),
          ),
        );
        const occurrences = current.split(input.oldText).length - 1;
        if (occurrences === 0) {
          return yield* new WorkspaceBridgeError({
            reason: "invalid-input",
            description: `oldText not found in ${guarded.relativePath}. Read the file and match it exactly, including whitespace.`,
          });
        }
        if (occurrences > 1 && input.replaceAll !== true) {
          return yield* new WorkspaceBridgeError({
            reason: "invalid-input",
            description: `oldText matches ${occurrences} places in ${guarded.relativePath}. Add more context to make it unique, or pass replaceAll: true.`,
          });
        }
        const next =
          input.replaceAll === true
            ? current.split(input.oldText).join(input.newText)
            : current.replace(input.oldText, input.newText);
        yield* fs.writeFileString(guarded.absolutePath, next).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceBridgeError({
                reason: "read-failed",
                description: `Could not write ${guarded.relativePath}: ${cause.message}`,
              }),
          ),
        );
        return {
          summary: `Edited ${guarded.relativePath} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
          filesChanged: [guarded.relativePath],
        };
      }),
    });
  });

  const patch: WorkspaceBridgeCoordinatorShape["patch"] = Effect.fn(
    "WorkspaceBridgeCoordinator.patch",
  )(function* (scope, input) {
    yield* requireCapability(scope, "patch");
    const { root, runtimeMode } = yield* requireThread(scope);

    const touched = extractPatchPaths(input.patch);
    if (touched.length === 0) {
      return yield* new WorkspaceBridgeError({
        reason: "invalid-input",
        description:
          "No a/…, b/… file headers found in the patch. Provide a unified diff as produced by `git diff`.",
      });
    }
    for (const path of touched) {
      const resolution = resolveWithin({ root, requestedPath: path });
      if (!resolution.ok) {
        return yield* new WorkspaceBridgeError({
          reason: "path-not-allowed",
          description: `Patch touches ${path}: ${describeRejection(resolution.rejection)}`,
        });
      }
    }

    return yield* stageMutation({
      scope,
      tool: "patch",
      runtimeMode,
      requestType: "apply_patch_approval",
      approvalDetail: truncateDetail(
        `ChatGPT wants to apply a patch to ${touched.join(", ")}:\n\n${input.patch}`,
      ),
      execute: Effect.gen(function* () {
        const runApply = (args: ReadonlyArray<string>) =>
          processRunner
            .run({
              command: "git",
              args,
              cwd: root,
              stdin: input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`,
              timeout: GIT_TIMEOUT,
              outputMode: "truncate",
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceBridgeError({
                    reason: "git-unavailable",
                    description: `Could not run git apply: ${cause.message}`,
                  }),
              ),
            );

        const check = yield* runApply(["apply", "--check", "--whitespace=nowarn", "-"]);
        if (check.code !== 0) {
          return yield* new WorkspaceBridgeError({
            reason: "invalid-input",
            description: `Patch does not apply cleanly: ${check.stderr.trim() || check.stdout.trim() || "unknown git apply error"}`,
          });
        }
        const applied = yield* runApply(["apply", "--whitespace=nowarn", "-"]);
        if (applied.code !== 0) {
          return yield* new WorkspaceBridgeError({
            reason: "invalid-input",
            description: `git apply failed after a clean check: ${applied.stderr.trim()}`,
          });
        }
        return {
          summary: `Applied patch to ${touched.length} file${touched.length === 1 ? "" : "s"} (${touched.join(", ")})`,
          filesChanged: touched,
        };
      }),
    });
  });

  const bash: WorkspaceBridgeCoordinatorShape["bash"] = Effect.fn(
    "WorkspaceBridgeCoordinator.bash",
  )(function* (scope, input) {
    yield* requireCapability(scope, "bash");
    const { root, runtimeMode } = yield* requireThread(scope);
    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);

    return yield* stageMutation({
      scope,
      tool: "bash",
      runtimeMode,
      requestType: "exec_command_approval",
      approvalDetail: truncateDetail(
        `ChatGPT wants to run in ${NodePath.basename(root)}:\n\n$ ${input.command}`,
      ),
      execute: Effect.gen(function* () {
        // `env -i` rebuilds the environment from scratch. The command's output
        // is relayed to OpenAI, so the server's own environment — API keys,
        // tokens, anything a dev shell exports — must not be observable from
        // inside the command.
        const output = yield* processRunner
          .run({
            command: "/usr/bin/env",
            args: [
              "-i",
              `PATH=${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
              `HOME=${process.env.HOME ?? root}`,
              `TMPDIR=${process.env.TMPDIR ?? "/tmp"}`,
              "TERM=dumb",
              "NO_COLOR=1",
              "CI=1",
              "/bin/bash",
              "-c",
              input.command,
            ],
            cwd: root,
            timeout: `${timeoutMs} millis`,
            maxOutputBytes: MAX_BASH_OUTPUT_BYTES,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceBridgeError({
                  reason: "invalid-input",
                  description: `Could not run the command: ${cause.message}`,
                }),
            ),
          );

        if (output.timedOut) {
          return {
            summary: `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${input.command}`,
            exitCode: null,
            output: "",
            truncated: false,
          };
        }
        const merged =
          output.stderr.trim().length > 0
            ? `${output.stdout}${output.stdout.endsWith("\n") || output.stdout.length === 0 ? "" : "\n"}[stderr]\n${output.stderr}`
            : output.stdout;
        const capped = truncateUtf8(merged, MAX_BASH_RESULT_BYTES);
        return {
          summary: `Ran \`${input.command}\` (exit ${output.code ?? "signal"})`,
          exitCode: output.code === null ? null : Number(output.code),
          output: capped.text,
          truncated: capped.truncated || output.stdoutTruncated || output.stderrTruncated,
        };
      }),
    });
  });

  const wait: WorkspaceBridgeCoordinatorShape["wait"] = Effect.fn(
    "WorkspaceBridgeCoordinator.wait",
  )(function* (scope, input) {
    const record = operations.get(input.operationId);
    if (!record || record.threadId !== scope.threadId) {
      return yield* new WorkspaceBridgeError({
        reason: "operation-not-found",
        description: `No operation ${input.operationId} for this thread. Operation ids are only valid for the session that created them.`,
      });
    }
    const waitSeconds = input.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    const settled = yield* Deferred.await(record.done).pipe(
      Effect.timeoutOption(`${waitSeconds} seconds`),
    );
    return Option.isSome(settled) ? settled.value : record.snapshot;
  });

  return WorkspaceBridgeCoordinator.of({
    overview,
    tree,
    read,
    search,
    changes,
    write,
    edit,
    patch,
    bash,
    wait,
  });
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

/**
 * Exposed for tests: shrink the in-call approval wait so a pending-approval
 * flow can be exercised without a 20-second stall per case.
 */
export const __testing = {
  setInitialApprovalWait(wait: Duration.Input): void {
    initialApprovalWait = wait;
  },
};
