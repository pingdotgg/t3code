/**
 * Aether mirror sync engine (build item 8).
 *
 * The local checkout is a driver-owned ONE-WAY MIRROR of the cloud VM for the
 * life of an Aether thread. At every turn settle this engine, in order:
 *   (a) verifies the mirror still matches the last synced state (content
 *       fingerprint recorded after each successful sync) — any divergence
 *       PAUSES sync loudly; the engine never applies over a diverged tree;
 *   (b) requests the cumulative WS `git diff` (mode main), fetches origin,
 *       and resolves the diff's own declared `baseRef` locally — pausing
 *       loudly if it does not resolve (an Aether-side rebase moves the
 *       merge-base; guessing would corrupt the mirror);
 *   (c) re-baselines with `git reset --hard <baseRef>` AND `git clean -fd`
 *       (never `-x`: gitignored artifacts survive; the diff's synthetic
 *       `added` entries are exactly what clean removes);
 *   (d) rebuilds a unified diff from the structured hunks and `git apply`s
 *       it; binary files arrive via the WS files channel (base64) and are
 *       written directly — bypassing `git apply`'s path validation, so their
 *       diff-supplied paths are checked against the checkout root here;
 *   (e) hands the outcome back so the caller emits `turn.diff.updated` and
 *       ONLY THEN `turn.completed`.
 *
 * Self-healing by construction: every successful sync reconstructs the full
 * state from the base, so a turn settled while detached settles immediately
 * with an empty checkpoint and the next successful sync captures the
 * combined delta (lazy catch-up).
 *
 * Every git invocation goes through the injected executor (the repo's
 * `GitVcsDriver.execute`) with the session's PROJECT cwd and is logged at
 * debug with its argv.
 *
 * @module provider/Layers/aether/mirrorSync
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GitCommandError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ExecuteGitInput, ExecuteGitResult } from "../../../vcs/GitVcsDriver.ts";
import type { AetherAgentConnection } from "./workspaceSocket.ts";
import type { AetherWsGitDiffFile, AetherWsGitDiffResult } from "./wireEvents.ts";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The one git surface the engine uses — structurally `GitVcsDriver.execute`. */
export interface AetherMirrorGit {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
}

/** The live-socket surface the engine drives (subset of the connection). */
export type AetherMirrorConnection = Pick<
  AetherAgentConnection,
  "requestGitDiff" | "readWorkspaceFile"
>;

/**
 * Narrow filesystem seam for the binary-file path. Defaults to node:fs —
 * injected only so failures can be simulated in tests.
 */
export interface AetherMirrorFs {
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly mkdir: (dir: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  /** Canonical, symlink-free path; rejects when `path` does not exist. */
  readonly realpath: (path: string) => Promise<string>;
  /** Is `path` ITSELF a symlink? `false` when it does not exist. */
  readonly isSymlink: (path: string) => Promise<boolean>;
}

const defaultMirrorFs: AetherMirrorFs = {
  writeFile: (path, bytes) => NodeFSP.writeFile(path, bytes),
  mkdir: async (dir) => {
    await NodeFSP.mkdir(dir, { recursive: true });
  },
  remove: (path) => NodeFSP.rm(path, { force: true }),
  realpath: (path) => NodeFSP.realpath(path),
  isSymlink: async (path) => {
    try {
      return (await NodeFSP.lstat(path)).isSymbolicLink();
    } catch (cause) {
      // "It is not there" is an answer; every other errno is a real failure
      // and must not be swallowed into a false "not a symlink".
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw cause;
    }
  },
};

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type AetherMirrorSyncOutcome =
  /** Full reset-and-apply completed; the checkpoint will capture a real delta. */
  | {
      readonly _tag: "synced";
      readonly unifiedDiff: string;
      readonly fileCount: number;
      /**
       * Paths whose only change was file MODE (chmod): the wire diff carries
       * no mode fields, so the change cannot be mirrored — surfaced as a
       * warning by the caller, never silently dropped and never a pause.
       */
      readonly modeOnlySkipped: ReadonlyArray<string>;
    }
  /**
   * No live workspace connection at settle time (detached / suspended VM).
   * The turn settles immediately with an empty checkpoint; the next
   * successful sync captures the combined delta. The tree was not touched.
   */
  | { readonly _tag: "skipped-detached"; readonly reason: string }
  /**
   * A transport-class failure interrupted the sync (request timeout, socket
   * drop). The tree is in a consistent state and the fingerprint was
   * re-recorded, so the next sync self-heals — surfaced as a warning, not a
   * pause.
   */
  | { readonly _tag: "skipped-transport"; readonly reason: string }
  /**
   * Sync is paused: local divergence, unresolvable base, apply failure, or a
   * contract break. `firstPause` distinguishes the loud error card from the
   * per-settle reminder warning.
   */
  | { readonly _tag: "paused"; readonly reason: string; readonly firstPause: boolean };

export interface AetherMirrorSyncEngine {
  /** Sync at one turn settle. Never fails — every failure mode is an outcome. */
  readonly syncAtSettle: (
    connection: AetherMirrorConnection | undefined,
  ) => Effect.Effect<AetherMirrorSyncOutcome>;
  /** The fingerprint of the last synced state (persisted via the resume cursor). */
  readonly lastSyncedFingerprint: () => string | undefined;
  /** Pause state, if any (sticky until the session restarts). */
  readonly pausedReason: () => string | undefined;
}

export interface AetherMirrorSyncOptions {
  /** The session's PROJECT cwd — the mirror checkout. Never the VM path. */
  readonly cwd: string;
  readonly git: AetherMirrorGit;
  readonly fs?: AetherMirrorFs;
  /**
   * The session's Aether task id (defined by the time any turn settles — a
   * sync without one fails loudly). Keys the mirror-local fingerprint record
   * so a stale record from another thread's task is never trusted.
   */
  readonly getTaskId: () => string | undefined;
  /**
   * HEAD sha recorded at session start. For a thread that has never synced,
   * the expected pre-sync state is exactly "clean tree at this HEAD".
   */
  readonly baselineHeadSha: string;
  /**
   * Fingerprint carried in the resume cursor for a thread with earlier
   * synced turns. Second in precedence: the mirror-local record (written in
   * the same breath as each sync) wins when present, because t3 snapshots
   * the cursor only at its own persistence beats — after a non-graceful
   * shutdown the cursor can lag the tree by whole turns, and trusting it
   * would misread the driver's own applied diff as user divergence.
   */
  readonly persistedFingerprint?: string | undefined;
  /** Retry policy for the workspace's "git write operation in progress" answer. */
  readonly writeLockRetry?: { readonly attempts: number; readonly delayMs: number };
}

// ---------------------------------------------------------------------------
// Unified-diff rebuild (pure; exported for tests)
// ---------------------------------------------------------------------------

/** A structured entry the rebuild cannot express — the sync must pause. */
export class AetherDiffRebuildError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "AetherDiffRebuildError";
    this.detail = detail;
  }
}

const LINE_PREFIX: Record<string, string> = {
  add: "+",
  del: "-",
  context: " ",
};

/** The named C escapes git writes; every other control byte becomes `\NNN`. */
const C_STYLE_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\u0007": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * Git's C-style quoting for a diff header path token (`a/…`, `b/…`, or the
 * bare path of a rename line). Interpolating a raw path that contains a
 * quote, a backslash or a control character yields a header `git apply`
 * REJECTS — which pauses the mirror permanently — so those three classes are
 * escaped and the token wrapped in quotes, exactly as git writes them.
 * Non-ASCII bytes are left raw: git quotes them for DISPLAY (core.quotePath)
 * but `git apply` reads raw UTF-8, and inside a quoted token they pass
 * through git's unquoting verbatim.
 */
function quoteGitDiffPath(token: string): string {
  let escaped = "";
  let quotingRequired = false;
  for (const character of token) {
    const literal = C_STYLE_ESCAPES[character];
    if (literal !== undefined) {
      escaped += literal;
      quotingRequired = true;
      continue;
    }
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      escaped += `\\${code.toString(8).padStart(3, "0")}`;
      quotingRequired = true;
      continue;
    }
    escaped += character;
  }
  return quotingRequired ? `"${escaped}"` : token;
}

function renderTextFilePatch(file: AetherWsGitDiffFile): string {
  const parts: Array<string> = [];
  const oldPath = file.status === "added" ? file.newPath : file.oldPath;
  const newPath = file.status === "deleted" ? file.oldPath : file.newPath;
  parts.push(`diff --git ${quoteGitDiffPath(`a/${oldPath}`)} ${quoteGitDiffPath(`b/${newPath}`)}`);
  switch (file.status) {
    case "added":
      parts.push("new file mode 100644");
      break;
    case "deleted":
      parts.push("deleted file mode 100644");
      break;
    case "renamed":
      parts.push(`rename from ${quoteGitDiffPath(file.oldPath)}`);
      parts.push(`rename to ${quoteGitDiffPath(file.newPath)}`);
      break;
    case "modified":
      break;
    default:
      throw new AetherDiffRebuildError(
        `Unknown git diff file status '${file.status}' for '${file.displayPath}'.`,
      );
  }
  if (file.hunks.length > 0) {
    parts.push(
      file.status === "added" ? "--- /dev/null" : `--- ${quoteGitDiffPath(`a/${oldPath}`)}`,
    );
    parts.push(
      file.status === "deleted" ? "+++ /dev/null" : `+++ ${quoteGitDiffPath(`b/${newPath}`)}`,
    );
    for (const hunk of file.hunks) {
      // Regenerate the @@ line from the numeric fields (authoritative);
      // the stored header text is display-oriented.
      parts.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      for (const line of hunk.lines) {
        const prefix = LINE_PREFIX[line.kind];
        if (prefix === undefined) {
          throw new AetherDiffRebuildError(
            `Unknown diff line kind '${line.kind}' in '${file.displayPath}'.`,
          );
        }
        parts.push(`${prefix}${line.text}`);
        if (line.noTrailingNewline === true) {
          parts.push("\\ No newline at end of file");
        }
      }
    }
  }
  return `${parts.join("\n")}\n`;
}

export interface RebuiltDiff {
  /** Unified text patch covering every non-binary entry ("" when none). */
  readonly patch: string;
  /** Binary entries, applied via the WS files channel + direct writes. */
  readonly binaries: ReadonlyArray<AetherWsGitDiffFile>;
  /**
   * Non-binary `modified` entries with ZERO hunks: a mode-only change
   * (chmod on an otherwise-untouched file). The wire schema carries no mode
   * fields, so the change is inexpressible locally — and rendering a bare
   * `diff --git` header makes `git apply` reject the WHOLE patch (verified:
   * "No valid patches in input" alone, "inconsistent old filename" when
   * concatenated). Excluded from the patch and reported so the caller warns.
   */
  readonly modeOnly: ReadonlyArray<string>;
}

/**
 * Rebuild a `git apply`-able unified diff from the structured GitDiffResult.
 * Throws `AetherDiffRebuildError` on any entry it cannot express — the
 * caller pauses loudly rather than half-applying.
 */
export function rebuildUnifiedDiff(diff: AetherWsGitDiffResult): RebuiltDiff {
  const textParts: Array<string> = [];
  const binaries: Array<AetherWsGitDiffFile> = [];
  const modeOnly: Array<string> = [];
  for (const file of diff.files) {
    if (file.isBinary) {
      binaries.push(file);
      continue;
    }
    if (file.status === "modified" && file.hunks.length === 0) {
      modeOnly.push(file.displayPath);
      continue;
    }
    textParts.push(renderTextFilePatch(file));
  }
  return { patch: textParts.join(""), binaries, modeOnly };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const WRITE_LOCK_PATTERN = /write operation is in progress/i;

/** Monotonic id source for per-engine temp index files. */
let mirrorEngineCounter = 0;

/** Internal control-flow error: pause the sync with this reason. */
class PauseSync {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}
/** Internal control-flow error: transport died mid-sync. */
class TransportSkip {
  readonly reason: string;
  readonly treeMutated: boolean;
  constructor(reason: string, treeMutated: boolean) {
    this.reason = reason;
    this.treeMutated = treeMutated;
  }
}

export function makeAetherMirrorSync(options: AetherMirrorSyncOptions): AetherMirrorSyncEngine {
  const fs = options.fs ?? defaultMirrorFs;
  const writeLockRetry = options.writeLockRetry ?? { attempts: 5, delayMs: 500 };
  const cwd = options.cwd;

  let lastSynced: string | undefined;
  /** One-shot: the first sync resolves the expected state from the durable records. */
  let fingerprintLoaded = false;
  let paused: string | undefined;
  // Stable per-engine temp index for content fingerprints: `git add -A`
  // against this side index captures tracked AND untracked content without
  // touching the real index; `.gitignore`d artifacts stay excluded, matching
  // `clean -fd` semantics. The name only needs uniqueness across engines in
  // this process — a monotonic counter suffices (no randomness).
  mirrorEngineCounter++;
  const tempIndexPath = NodePath.join(
    NodeOS.tmpdir(),
    `t3-aether-mirror-index-${process.pid}-${mirrorEngineCounter}`,
  );

  const git = (
    operation: string,
    args: ReadonlyArray<string>,
    extra?: Partial<ExecuteGitInput>,
  ): Effect.Effect<ExecuteGitResult, GitCommandError> =>
    Effect.logDebug("aether.mirror.git", { cwd, argv: ["git", ...args] }).pipe(
      Effect.andThen(options.git.execute({ operation, cwd, args, ...extra })),
    );

  const gitStdout = (operation: string, args: ReadonlyArray<string>) =>
    git(operation, args).pipe(Effect.map((result) => result.stdout.trim()));

  /** `<HEAD sha>:<content tree sha>` — catches edits, untracked files AND local commits. */
  const captureFingerprint: Effect.Effect<string, GitCommandError> = Effect.gen(function* () {
    const headSha = yield* gitStdout("aether.mirror.fingerprint", ["rev-parse", "HEAD"]);
    const env = { GIT_INDEX_FILE: tempIndexPath };
    yield* git("aether.mirror.fingerprint", ["read-tree", "HEAD"], { env });
    yield* git("aether.mirror.fingerprint", ["add", "-A", "."], { env });
    const treeSha = yield* git("aether.mirror.fingerprint", ["write-tree"], { env }).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
    return `${headSha}:${treeSha}`;
  });

  /**
   * The mirror-local fingerprint record: `git config --local`, written in
   * the SAME breath as every successful sync. The resume cursor is
   * snapshotted only at t3's own persistence beats (startSession return /
   * sendTurn return / stopAll), so after a crash it can lag the tree by whole
   * turns — a fingerprint that travels with the tree it describes is the only
   * record that is never stale.
   *
   * The KEY carries the task id because `--local` is repository-scoped, NOT
   * worktree-scoped: every Aether thread gets its own worktree of the same
   * repo, so a single shared key would have each thread's settle overwrite
   * the others' record — the keyed lookup would then miss on every resume and
   * fall back to the cursor, defeating the whole point of the record.
   */
  const fingerprintConfigKey = (taskId: string) => `t3.${taskId}.aetherMirrorFingerprint`;

  /**
   * Task ids reach us from the Aether API and end up in a git config key, whose
   * grammar accepts far less than an arbitrary string. Anything outside the
   * shape ids actually have is refused loudly rather than handed to git.
   */
  const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

  const requireTaskId: Effect.Effect<string, PauseSync> = Effect.suspend(() => {
    const taskId = options.getTaskId();
    if (taskId === undefined) {
      return Effect.fail(
        new PauseSync(
          "The session has no Aether task id at settle time; refusing to sync the mirror without one.",
        ),
      );
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
      return Effect.fail(
        new PauseSync(
          `The Aether task id '${taskId}' is not a valid mirror fingerprint record key; refusing to sync.`,
        ),
      );
    }
    return Effect.succeed(taskId);
  });

  const persistFingerprint = (taskId: string, fingerprint: string) =>
    git("aether.mirror.fingerprint-store", [
      "config",
      "--local",
      fingerprintConfigKey(taskId),
      `${taskId} ${fingerprint}`,
    ]).pipe(
      Effect.mapError(
        (error) =>
          new PauseSync(`Could not persist the mirror fingerprint record: ${error.message}`),
      ),
      Effect.asVoid,
    );

  const readPersistedFingerprint = (taskId: string): Effect.Effect<string | undefined, PauseSync> =>
    Effect.gen(function* () {
      const result = yield* git(
        "aether.mirror.fingerprint-store",
        ["config", "--local", "--get", fingerprintConfigKey(taskId)],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.mapError(
          (error) =>
            new PauseSync(`Could not read the mirror fingerprint record: ${error.message}`),
        ),
      );
      if (result.exitCode !== 0) {
        // `git config --get` exits 1 when the key is unset — the only
        // non-zero exit that means "no record" rather than a failure.
        if (result.exitCode === 1) {
          return undefined;
        }
        return yield* Effect.fail(
          new PauseSync(
            `Could not read the mirror fingerprint record (git config exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
          ),
        );
      }
      const value = result.stdout.trim();
      if (value.length === 0) {
        return undefined;
      }
      const separator = value.indexOf(" ");
      if (separator === -1) {
        return yield* Effect.fail(
          new PauseSync(
            `The mirror fingerprint record '${value}' is corrupt (expected '<taskId> <fingerprint>'). ` +
              `Remove it (git config --local --unset ${fingerprintConfigKey(taskId)}) to recover.`,
          ),
        );
      }
      // A record from ANOTHER task (an earlier thread in this cwd) is not
      // ours — the keyed lookup misses and the cursor/baseline decide.
      return value.slice(0, separator) === taskId ? value.slice(separator + 1) : undefined;
    });

  const expectedFingerprint = (
    taskId: string,
  ): Effect.Effect<string, GitCommandError | PauseSync> =>
    Effect.gen(function* () {
      if (!fingerprintLoaded) {
        fingerprintLoaded = true;
        // Precedence: mirror-local record (never stale) > resume cursor.
        const stored = yield* readPersistedFingerprint(taskId);
        lastSynced = stored ?? options.persistedFingerprint;
      }
      if (lastSynced !== undefined) {
        return lastSynced;
      }
      // Never-synced thread: the expected state is a clean tree at the
      // baseline HEAD recorded when the session started.
      const baselineTree = yield* gitStdout("aether.mirror.fingerprint", [
        "rev-parse",
        `${options.baselineHeadSha}^{tree}`,
      ]);
      return `${options.baselineHeadSha}:${baselineTree}`;
    });

  const requestDiffWithLockRetry = (connection: AetherMirrorConnection) =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* connection.requestGitDiff({ mode: "main" }).pipe(Effect.result);
        if (Result.isSuccess(outcome)) {
          return outcome.success;
        }
        const error = outcome.failure;
        if (
          error._tag === "AetherWorkspaceRequestFailedError" &&
          WRITE_LOCK_PATTERN.test(error.detail) &&
          attempt < writeLockRetry.attempts
        ) {
          yield* Effect.logDebug("aether.mirror.diff.write-lock-retry", { attempt });
          yield* Effect.sleep(Duration.millis(writeLockRetry.delayMs));
          continue;
        }
        return yield* error;
      }
    });

  /**
   * Resolve one diff-supplied path inside the mirror checkout. Binary
   * entries are written and deleted DIRECTLY — they never pass through
   * `git apply`, whose own path validation is what protects every hunk
   * path — so this is the only thing standing between a malformed (or
   * hostile) workspace diff and a write outside the checkout: an absolute
   * path makes `join(cwd, …)` return the path itself, and a `..` segment
   * walks straight out.
   */
  const resolveInMirror = (relative: string): Effect.Effect<string, PauseSync> =>
    Effect.gen(function* () {
      const refuse = (why: string) =>
        new PauseSync(
          `The workspace diff names a binary path that escapes the mirror checkout (${why}): '${relative}'.`,
        );
      if (relative.length === 0) {
        return yield* Effect.fail(refuse("empty path"));
      }
      if (NodePath.isAbsolute(relative)) {
        return yield* Effect.fail(refuse("absolute path"));
      }
      // Both separators: a Windows-style '..\\x' is a traversal too, and a
      // backslash in a POSIX name is not worth the ambiguity.
      const segments = relative.split(/[/\\]/).filter((segment) => segment !== "");
      if (segments.includes("..")) {
        return yield* Effect.fail(refuse("'..' segment"));
      }
      // Direct writes bypass git's own refusal to track files under .git —
      // a write to .git/config or .git/hooks/* corrupts the mirror's
      // metadata (hooks = code execution on the next git invocation). Git
      // never tracks such paths, so a legitimate diff cannot name them.
      if (segments.some((segment) => segment.toLowerCase() === ".git")) {
        return yield* Effect.fail(refuse("'.git' segment"));
      }
      if (segments.every((segment) => segment === ".")) {
        return yield* Effect.fail(refuse("empty path"));
      }
      // LEXICAL validation is not enough: `writeFile` and `mkdir` FOLLOW
      // symlinks, so a diff naming an existing symlink inside the checkout
      // (or any path underneath one) writes wherever it points — outside the
      // checkout, or into .git. Walk the segments down from the checkout's
      // REAL root and refuse the first component that is itself a symlink;
      // what comes back is then a real path inside the real root by
      // construction, with no containment check left to get wrong.
      const root = yield* Effect.tryPromise({
        try: () => fs.realpath(cwd),
        catch: (cause) =>
          new PauseSync(`Could not resolve the mirror checkout '${cwd}': ${String(cause)}`),
      });
      let resolved = root;
      for (const segment of segments) {
        if (segment === ".") {
          continue;
        }
        resolved = NodePath.join(resolved, segment);
        const symlink = yield* Effect.tryPromise({
          try: () => fs.isSymlink(resolved),
          catch: (cause) =>
            new PauseSync(
              `Could not inspect '${relative}' inside the mirror checkout: ${String(cause)}`,
            ),
        });
        if (symlink) {
          return yield* Effect.fail(refuse(`'${segment}' is a symlink`));
        }
      }
      return resolved;
    });

  const applyBinaries = (
    connection: AetherMirrorConnection,
    binaries: ReadonlyArray<AetherWsGitDiffFile>,
  ) =>
    Effect.gen(function* () {
      // PASS 1: resolve/validate EVERY path in the batch before touching the
      // filesystem. A rename with a safe oldPath and an escaping newPath
      // must refuse before the removal — a failed sync may never leave the
      // mirror partially mutated by its own validation error.
      const resolvedTargets = new Map<string, string>();
      for (const file of binaries) {
        if (file.status === "deleted" || file.status === "renamed") {
          resolvedTargets.set(`old:${file.oldPath}`, yield* resolveInMirror(file.oldPath));
        }
        if (file.status !== "deleted") {
          resolvedTargets.set(`new:${file.newPath}`, yield* resolveInMirror(file.newPath));
        }
      }
      // PASS 2 then PASS 3 — every removal strictly before every write. One
      // cumulative diff can name the same path as one entry's new target and
      // another entry's old path (a delete of `a` alongside a rename of
      // `b`→`a`); interleaving lets the later removal clobber the earlier
      // write, and the sync then fingerprints and REPORTS a tree that is
      // missing a file the diff says exists.
      for (const file of binaries) {
        if (file.status === "deleted" || file.status === "renamed") {
          const stale = resolvedTargets.get(`old:${file.oldPath}`)!;
          yield* Effect.tryPromise({
            try: () => fs.remove(stale),
            catch: (cause) =>
              new PauseSync(`Failed to remove binary file '${file.oldPath}': ${String(cause)}`),
          });
        }
      }
      for (const file of binaries) {
        if (file.status === "deleted") {
          continue;
        }
        const target = resolvedTargets.get(`new:${file.newPath}`)!;
        const read = yield* connection.readWorkspaceFile(file.newPath).pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "AetherWorkspaceRequestTimeoutError":
              case "AetherWorkspaceDetachedError":
                return new TransportSkip(
                  `Binary file '${file.newPath}' could not be read before the connection dropped: ${error.message}`,
                  true,
                );
              default:
                return new PauseSync(
                  `Failed to read binary file '${file.newPath}' from the workspace: ${error.message}`,
                );
            }
          }),
        );
        const bytes =
          read.encoding === "base64"
            ? Uint8Array.from(Buffer.from(read.content, "base64"))
            : new TextEncoder().encode(read.content);
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(NodePath.dirname(target));
            await fs.writeFile(target, bytes);
          },
          catch: (cause) =>
            new PauseSync(`Failed to write binary file '${file.newPath}': ${String(cause)}`),
        });
      }
    });

  const runSync = (connection: AetherMirrorConnection) =>
    Effect.gen(function* () {
      const taskId = yield* requireTaskId;
      // (a) Verify the mirror still matches the last synced state.
      const current = yield* captureFingerprint.pipe(
        Effect.mapError(
          (error) => new PauseSync(`Could not fingerprint the local checkout: ${error.message}`),
        ),
      );
      const expected = yield* expectedFingerprint(taskId).pipe(
        Effect.mapError((error) =>
          error instanceof PauseSync
            ? error
            : new PauseSync(`Could not compute the expected mirror state: ${error.message}`),
        ),
      );
      if (current !== expected) {
        return yield* Effect.fail(
          new PauseSync(
            `The local checkout diverged from the last synced state (expected ${expected}, found ${current}). ` +
              "The checkout is a one-way mirror of the Aether workspace — local edits, commits and branch " +
              "operations are unsupported during a cloud session. Restore the checkout (or start a fresh " +
              "thread from a clean checkout) to resume syncing.",
          ),
        );
      }

      // (b) The cumulative diff, then re-baseline onto ITS declared base.
      const diff = yield* requestDiffWithLockRetry(connection).pipe(
        Effect.mapError((error) => {
          if (error instanceof PauseSync || error instanceof TransportSkip) {
            return error;
          }
          switch (error._tag) {
            case "AetherWorkspaceRequestTimeoutError":
            case "AetherWorkspaceDetachedError":
              return new TransportSkip(
                `The workspace diff request did not complete: ${error.message}`,
                false,
              );
            default:
              return new PauseSync(`The workspace diff request failed: ${error.message}`);
          }
        }),
      );

      // Fetch is freshness, resolution is the check: pause only when the
      // declared base cannot be resolved locally.
      yield* git("aether.mirror.fetch", ["fetch", "origin"]).pipe(
        Effect.catch((error) =>
          Effect.logWarning("aether.mirror.fetch.failed", { detail: error.message }),
        ),
      );
      const resolvedBase = yield* git("aether.mirror.resolve-base", [
        "rev-parse",
        "--verify",
        `${diff.baseRef}^{commit}`,
      ]).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(
          () =>
            new PauseSync(
              `The diff's declared base '${diff.baseRef}' does not resolve in the local checkout ` +
                "even after fetching origin. The mirror cannot be re-baselined safely.",
            ),
        ),
      );

      // (c) reset --hard <baseRef> AND clean -fd (never -x).
      const mutate = (operation: string, args: ReadonlyArray<string>) =>
        git(operation, args).pipe(
          Effect.mapError(
            (error) =>
              new PauseSync(`Mirror re-baseline failed (${args.join(" ")}): ${error.message}`),
          ),
        );
      yield* mutate("aether.mirror.reset", ["reset", "--hard", resolvedBase]);
      yield* mutate("aether.mirror.clean", ["clean", "-fd"]);

      // (d) Rebuild + apply the FULL cumulative diff.
      const rebuilt = yield* Effect.try({
        try: () => rebuildUnifiedDiff(diff),
        catch: (cause) =>
          cause instanceof AetherDiffRebuildError
            ? new PauseSync(`The workspace diff cannot be rebuilt locally: ${cause.detail}`)
            : new PauseSync(`The workspace diff cannot be rebuilt locally: ${String(cause)}`),
      });
      if (rebuilt.patch.length > 0) {
        const applied = yield* git("aether.mirror.apply", ["apply", "--whitespace=nowarn", "-"], {
          stdin: rebuilt.patch,
          allowNonZeroExit: true,
        }).pipe(
          Effect.mapError((error) => new PauseSync(`git apply could not run: ${error.message}`)),
        );
        if (applied.exitCode !== 0) {
          return yield* Effect.fail(
            new PauseSync(
              `git apply rejected the cumulative diff (exit ${String(applied.exitCode)}): ${applied.stderr.trim()}`,
            ),
          );
        }
      }
      yield* applyBinaries(connection, rebuilt.binaries);

      // Record the new synced state — in memory AND in the mirror-local
      // record, so a crash between now and t3's next cursor snapshot cannot
      // make the next resume misread this very sync as user divergence.
      const fingerprint = yield* captureFingerprint.pipe(
        Effect.mapError(
          (error) =>
            new PauseSync(`Could not fingerprint the checkout after syncing: ${error.message}`),
        ),
      );
      yield* persistFingerprint(taskId, fingerprint);
      lastSynced = fingerprint;
      return {
        _tag: "synced",
        unifiedDiff: rebuilt.patch,
        fileCount: diff.files.length,
        modeOnlySkipped: rebuilt.modeOnly,
      } as const;
    });

  const syncAtSettle: AetherMirrorSyncEngine["syncAtSettle"] = (connection) =>
    Effect.gen(function* () {
      if (paused !== undefined) {
        return { _tag: "paused", reason: paused, firstPause: false } as const;
      }
      if (connection === undefined) {
        return {
          _tag: "skipped-detached",
          reason:
            "no live workspace connection; the next successful sync captures the combined delta",
        } as const;
      }
      const outcome = yield* runSync(connection).pipe(Effect.result);
      if (Result.isSuccess(outcome)) {
        return outcome.success;
      }
      const error = outcome.failure;
      if (error instanceof TransportSkip) {
        if (error.treeMutated) {
          // The tree changed under a partially completed sync; re-record
          // (memory + mirror-local record) so the next sync verifies against
          // reality and rebuilds from base.
          const recaptured = yield* Effect.result(
            Effect.gen(function* () {
              const taskId = yield* requireTaskId;
              const fingerprint = yield* captureFingerprint.pipe(
                Effect.mapError(
                  (cause) =>
                    new PauseSync(
                      `Could not re-fingerprint the checkout after an interrupted sync: ${cause.message}`,
                    ),
                ),
              );
              yield* persistFingerprint(taskId, fingerprint);
              return fingerprint;
            }),
          );
          if (Result.isSuccess(recaptured)) {
            lastSynced = recaptured.success;
          } else {
            paused = recaptured.failure.reason;
            return { _tag: "paused", reason: paused, firstPause: true } as const;
          }
        }
        return { _tag: "skipped-transport", reason: error.reason } as const;
      }
      paused = error.reason;
      return { _tag: "paused", reason: paused, firstPause: true } as const;
    });

  return {
    syncAtSettle,
    // Before the first post-(re)start sync the engine has not resolved the
    // durable records yet — echo the cursor's fingerprint so a resume that
    // never syncs does not silently drop it from the next cursor.
    lastSyncedFingerprint: () => lastSynced ?? options.persistedFingerprint,
    pausedReason: () => paused,
  };
}
