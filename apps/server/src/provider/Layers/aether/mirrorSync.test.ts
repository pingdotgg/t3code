/**
 * Mirror sync engine acceptance tests (spec build item 8) over REAL temp git
 * repositories: an "upstream" repo standing in for origin and a cloned
 * "mirror" standing in for the thread's local checkout. The VM side is
 * simulated by hand-built structured GitDiffResult fixtures — exactly the
 * cumulative merge-base→tree shape the workspace WS serves.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import * as GitVcsDriverModule from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  makeAetherMirrorSync,
  rebuildUnifiedDiff,
  type AetherMirrorConnection,
} from "./mirrorSync.ts";
import type { AetherWsGitDiffFile, AetherWsGitDiffResult } from "./wireEvents.ts";
import {
  AetherWorkspaceRequestTimeoutError,
  type AetherWorkspaceRequestError,
} from "./workspaceSocket.ts";

const TestLayer = GitVcsDriverModule.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-aether-mirror-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

// ---------------------------------------------------------------------------
// Structured-diff fixture builders (the wire shape, built from file contents)
// ---------------------------------------------------------------------------

interface FixtureLine {
  readonly kind: "add" | "del" | "context";
  readonly text: string;
  readonly noTrailingNewline?: boolean;
}

function toLines(content: string, kind: "add" | "del"): Array<FixtureLine> {
  if (content.length === 0) {
    return [];
  }
  const hasTrailingNewline = content.endsWith("\n");
  const raw = (hasTrailingNewline ? content.slice(0, -1) : content).split("\n");
  return raw.map((text, index) => ({
    kind,
    text,
    ...(index === raw.length - 1 && !hasTrailingNewline ? { noTrailingNewline: true } : {}),
  }));
}

const countOf = (content: string): number => toLines(content, "add").length;

function addedFile(path: string, content: string): AetherWsGitDiffFile {
  return {
    // The real wire sends "/dev/null" for added entries (aether
    // packages/diff/src/index.ts) — and [] hunks for an EMPTY added file.
    oldPath: "/dev/null",
    newPath: path,
    displayPath: path,
    status: "added",
    isBinary: false,
    hunks:
      content.length === 0
        ? []
        : [
            {
              header: `@@ -0,0 +1,${countOf(content)} @@`,
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: countOf(content),
              lines: toLines(content, "add"),
            },
          ],
  };
}

function deletedFile(path: string, oldContent: string): AetherWsGitDiffFile {
  return {
    oldPath: path,
    // The real wire sends "/dev/null" for deleted entries.
    newPath: "/dev/null",
    displayPath: path,
    status: "deleted",
    isBinary: false,
    hunks:
      oldContent.length === 0
        ? []
        : [
            {
              header: `@@ -1,${countOf(oldContent)} +0,0 @@`,
              oldStart: 1,
              oldCount: countOf(oldContent),
              newStart: 0,
              newCount: 0,
              lines: toLines(oldContent, "del"),
            },
          ],
  };
}

function renamedFile(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
): AetherWsGitDiffFile {
  return {
    oldPath,
    newPath,
    displayPath: newPath,
    status: "renamed",
    isBinary: false,
    // A PURE rename carries zero hunks on the wire.
    hunks:
      oldContent === newContent
        ? []
        : [
            {
              header: "@@",
              oldStart: 1,
              oldCount: countOf(oldContent),
              newStart: 1,
              newCount: countOf(newContent),
              lines: [...toLines(oldContent, "del"), ...toLines(newContent, "add")],
            },
          ],
  };
}

/** A chmod-only change: raw `M` record with no content hunks. */
function modeOnlyFile(path: string): AetherWsGitDiffFile {
  return {
    oldPath: path,
    newPath: path,
    displayPath: path,
    status: "modified",
    isBinary: false,
    hunks: [],
  };
}

function modifiedFile(path: string, oldContent: string, newContent: string): AetherWsGitDiffFile {
  return {
    oldPath: path,
    newPath: path,
    displayPath: path,
    status: "modified",
    isBinary: false,
    hunks: [
      {
        header: "@@",
        oldStart: 1,
        oldCount: countOf(oldContent),
        newStart: 1,
        newCount: countOf(newContent),
        lines: [...toLines(oldContent, "del"), ...toLines(newContent, "add")],
      },
    ],
  };
}

const diffResult = (
  baseRef: string,
  files: ReadonlyArray<AetherWsGitDiffFile>,
): AetherWsGitDiffResult => ({ baseRef, files });

/** A connection whose diff answers are scripted per call (last repeats). */
function scriptedConnection(
  answers: ReadonlyArray<AetherWsGitDiffResult | AetherWorkspaceRequestError>,
): AetherMirrorConnection & { readonly diffCalls: () => number } {
  let calls = 0;
  return {
    requestGitDiff: () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      return "baseRef" in answer ? Effect.succeed(answer) : Effect.fail(answer);
    },
    readWorkspaceFile: (path) =>
      Effect.succeed({
        success: true as const,
        content: Buffer.from(`binary:${path}`).toString("base64"),
        encoding: "base64" as const,
        isBinary: true,
      }),
    diffCalls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Fixture repos
// ---------------------------------------------------------------------------

const INITIAL_APP = "one\ntwo\n";

const setupRepos = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriverModule.GitVcsDriver;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-aether-mirror-" });

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "mirrorSync.test", cwd, args, timeoutMs: 15_000 })
      .pipe(Effect.map((result) => result.stdout.trim()));

  const upstream = path.join(base, "upstream");
  yield* fileSystem.makeDirectory(upstream);
  yield* git(upstream, ["init", "--initial-branch", "main"]);
  yield* git(upstream, ["config", "user.email", "test@test.test"]);
  yield* git(upstream, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(upstream, "app.txt"), INITIAL_APP);
  yield* fileSystem.writeFileString(path.join(upstream, "lib.txt"), "lib\n");
  yield* fileSystem.writeFileString(path.join(upstream, ".gitignore"), "build/\n");
  yield* git(upstream, ["add", "-A"]);
  yield* git(upstream, ["commit", "-m", "init"]);
  const baseSha = yield* git(upstream, ["rev-parse", "HEAD"]);

  yield* git(base, ["clone", upstream, "mirror"]);
  const mirror = path.join(base, "mirror");
  yield* git(mirror, ["config", "user.email", "test@test.test"]);
  yield* git(mirror, ["config", "user.name", "Test"]);

  const readMirrorFile = (relative: string) =>
    fileSystem.readFileString(path.join(mirror, relative));
  const mirrorFileExists = (relative: string) => fileSystem.exists(path.join(mirror, relative));
  const writeMirrorFile = (relative: string, content: string) =>
    fileSystem.writeFileString(path.join(mirror, relative), content);
  const makeMirrorDirectory = (relative: string) =>
    fileSystem.makeDirectory(path.join(mirror, relative), { recursive: true });

  /**
   * The EXACT mirror tree (tracked ∪ untracked, gitignored artifacts and
   * files deleted from disk excluded), as path → content — spec item 8:
   * "turn N's tree must be exact", which per-file spot checks cannot prove.
   */
  const mirrorTree = Effect.gen(function* () {
    const listing = yield* git(mirror, ["ls-files", "-co", "--exclude-standard"]);
    const paths = [...new Set(listing.split("\n").filter((line) => line.length > 0))].sort();
    const entries: Record<string, string> = {};
    for (const relative of paths) {
      // `ls-files -c` lists INDEX entries even when apply deleted the file
      // from disk — the tree we assert on is the working tree.
      if (yield* mirrorFileExists(relative)) {
        entries[relative] = yield* readMirrorFile(relative);
      }
    }
    return entries;
  });

  return {
    upstream,
    mirror,
    git,
    baseSha,
    driver,
    readMirrorFile,
    mirrorFileExists,
    writeMirrorFile,
    makeMirrorDirectory,
    mirrorTree,
  };
});

const makeEngine = (
  repos: {
    readonly mirror: string;
    readonly baseSha: string;
    readonly driver: GitVcsDriverModule.GitVcsDriver["Service"];
  },
  overrides?: {
    readonly taskId?: string;
    readonly persistedFingerprint?: string;
  },
) =>
  makeAetherMirrorSync({
    cwd: repos.mirror,
    git: repos.driver,
    baselineHeadSha: repos.baseSha,
    getTaskId: () => overrides?.taskId ?? "task-1",
    ...(overrides?.persistedFingerprint !== undefined
      ? { persistedFingerprint: overrides.persistedFingerprint }
      : {}),
    writeLockRetry: { attempts: 1, delayMs: 0 },
  });

describe("rebuildUnifiedDiff", () => {
  it("renders added, modified and no-trailing-newline entries", () => {
    const rebuilt = rebuildUnifiedDiff(
      diffResult("base", [
        addedFile("notes.md", "hello"),
        modifiedFile("app.txt", "one\ntwo\n", "one\ntwo\nthree\n"),
      ]),
    );
    expect(rebuilt.binaries).toHaveLength(0);
    expect(rebuilt.patch).toContain("diff --git a/notes.md b/notes.md");
    expect(rebuilt.patch).toContain("new file mode 100644");
    expect(rebuilt.patch).toContain("--- /dev/null");
    expect(rebuilt.patch).toContain("+hello\n\\ No newline at end of file");
    expect(rebuilt.patch).toContain("@@ -1,2 +1,3 @@");
  });

  it("excludes mode-only entries (zero-hunk modified) instead of emitting a bare header", () => {
    // A bare `diff --git` line makes git apply reject the WHOLE patch
    // ("No valid patches in input" / "inconsistent old filename") — verified
    // against real git; the entry must be excluded and reported.
    const rebuilt = rebuildUnifiedDiff(
      diffResult("base", [modeOnlyFile("tools/run.sh"), addedFile("notes.md", "hello\n")]),
    );
    expect(rebuilt.modeOnly).toEqual(["tools/run.sh"]);
    expect(rebuilt.patch).not.toContain("tools/run.sh");
    expect(rebuilt.patch).toContain("diff --git a/notes.md b/notes.md");
  });

  it("renders deleted, renamed and pure-rename entries", () => {
    const rebuilt = rebuildUnifiedDiff(
      diffResult("base", [
        deletedFile("gone.txt", "bye\n"),
        renamedFile("lib.txt", "moved.txt", "lib\n", "lib\n"),
      ]),
    );
    expect(rebuilt.modeOnly).toEqual([]);
    expect(rebuilt.patch).toContain("diff --git a/gone.txt b/gone.txt");
    expect(rebuilt.patch).toContain("deleted file mode 100644");
    expect(rebuilt.patch).toContain("+++ /dev/null");
    // Pure rename: header lines only, no hunks.
    expect(rebuilt.patch).toContain("rename from lib.txt");
    expect(rebuilt.patch).toContain("rename to moved.txt");
  });

  it("throws on a diff line kind it cannot express", () => {
    expect(() =>
      rebuildUnifiedDiff(
        diffResult("base", [
          {
            ...addedFile("x.txt", "x\n"),
            hunks: [
              {
                header: "@@",
                oldStart: 0,
                oldCount: 0,
                newStart: 1,
                newCount: 1,
                lines: [{ kind: "sideband", text: "x" }],
              },
            ],
          },
        ]),
      ),
    ).toThrowError(/Unknown diff line kind/);
  });
});

it.layer(TestLayer)("mirror sync engine (real git fixtures)", (it) => {
  it.effect(
    "3+ turns: re-touched files, untracked add/re-touch, moved merge-base, detached catch-up",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);

        // A gitignored artifact must survive every sync (clean -fd, never -x).
        yield* repos.makeMirrorDirectory("build");
        yield* repos.writeMirrorFile("build/cache.txt", "artifact\n");

        // -- turn 1: modify a tracked file, add an untracked one -----------
        const turn1 = scriptedConnection([
          diffResult(repos.baseSha, [
            modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nthree\n"),
            addedFile("notes.md", "hello\n"),
          ]),
        ]);
        const outcome1 = yield* engine.syncAtSettle(turn1);
        expect(outcome1._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("app.txt")).toBe("one\ntwo\nthree\n");
        expect(yield* repos.readMirrorFile("notes.md")).toBe("hello\n");
        expect(yield* repos.readMirrorFile("build/cache.txt")).toBe("artifact\n");

        // -- turn 2: BOTH files re-touched; the diff is CUMULATIVE ----------
        // Without reset + clean the re-apply would fail: app.txt's old sides
        // no longer match and notes.md "already exists".
        const turn2 = scriptedConnection([
          diffResult(repos.baseSha, [
            modifiedFile("app.txt", INITIAL_APP, "zero\none\ntwo\nthree\n"),
            addedFile("notes.md", "hello\nworld\n"),
          ]),
        ]);
        const outcome2 = yield* engine.syncAtSettle(turn2);
        expect(outcome2._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("app.txt")).toBe("zero\none\ntwo\nthree\n");
        expect(yield* repos.readMirrorFile("notes.md")).toBe("hello\nworld\n");
        expect(yield* repos.readMirrorFile("build/cache.txt")).toBe("artifact\n");

        // -- turn 3: the merge-base MOVED (Aether-side rebase) --------------
        // The new base exists only upstream until the engine fetches origin.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(repos.upstream, "upstream.txt"),
          "from upstream\n",
        );
        yield* fileSystem.writeFileString(path.join(repos.upstream, "app.txt"), "rebased\n");
        yield* repos.git(repos.upstream, ["add", "-A"]);
        yield* repos.git(repos.upstream, ["commit", "-m", "base moved"]);
        const movedBase = yield* repos.git(repos.upstream, ["rev-parse", "HEAD"]);

        const turn3 = scriptedConnection([
          diffResult(movedBase, [
            modifiedFile("app.txt", "rebased\n", "rebased\nplus agent work\n"),
            addedFile("notes.md", "hello\nworld\nagain\n"),
          ]),
        ]);
        const outcome3 = yield* engine.syncAtSettle(turn3);
        expect(outcome3._tag).toBe("synced");
        // The tree is EXACTLY base(moved) + cumulative diff.
        expect(yield* repos.readMirrorFile("app.txt")).toBe("rebased\nplus agent work\n");
        expect(yield* repos.readMirrorFile("upstream.txt")).toBe("from upstream\n");
        expect(yield* repos.readMirrorFile("notes.md")).toBe("hello\nworld\nagain\n");
        expect(yield* repos.readMirrorFile("build/cache.txt")).toBe("artifact\n");

        // -- turn 4: settled while DETACHED — empty checkpoint, no touch ----
        const outcome4 = yield* engine.syncAtSettle(undefined);
        expect(outcome4._tag).toBe("skipped-detached");
        expect(yield* repos.readMirrorFile("app.txt")).toBe("rebased\nplus agent work\n");

        // -- turn 5: catch-up — the next sync captures the combined delta ---
        const turn5 = scriptedConnection([
          diffResult(movedBase, [
            modifiedFile("app.txt", "rebased\n", "rebased\nplus agent work\nand turn five\n"),
            addedFile("notes.md", "hello\nworld\nagain\nand again\n"),
            addedFile("fresh.txt", "new in turn five\n"),
          ]),
        ]);
        const outcome5 = yield* engine.syncAtSettle(turn5);
        expect(outcome5._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("app.txt")).toBe(
          "rebased\nplus agent work\nand turn five\n",
        );
        expect(yield* repos.readMirrorFile("fresh.txt")).toBe("new in turn five\n");
        expect(engine.lastSyncedFingerprint()).toBeDefined();
        expect(engine.pausedReason()).toBeUndefined();
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "pauses loudly on local divergence (user edit between turns) and never re-applies",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const turn1 = scriptedConnection([
          diffResult(repos.baseSha, [modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nthree\n")]),
        ]);
        expect((yield* engine.syncAtSettle(turn1))._tag).toBe("synced");

        // The user edits the mirror between turns.
        yield* repos.writeMirrorFile("app.txt", "my local edit\n");

        const turn2 = scriptedConnection([
          diffResult(repos.baseSha, [modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nfour\n")]),
        ]);
        const outcome = yield* engine.syncAtSettle(turn2);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("diverged");
        }
        // NEVER applied over the diverged tree: the local edit survives.
        expect(yield* repos.readMirrorFile("app.txt")).toBe("my local edit\n");
        // The diff was never requested — verify runs first.
        expect(turn2.diffCalls()).toBe(0);
        // The pause is sticky (subsequent settles are sync-skipped, quieter).
        const again = yield* engine.syncAtSettle(turn2);
        expect(again).toMatchObject({ _tag: "paused", firstPause: false });
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "the fingerprint catches a local COMMIT too (base diverged, clean tree)",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const turn1 = scriptedConnection([
          diffResult(repos.baseSha, [addedFile("notes.md", "hello\n")]),
        ]);
        expect((yield* engine.syncAtSettle(turn1))._tag).toBe("synced");

        // Commit the applied state: content identical, HEAD moved, tree clean.
        yield* repos.git(repos.mirror, ["add", "-A"]);
        yield* repos.git(repos.mirror, ["commit", "-m", "local commit"]);

        const outcome = yield* engine.syncAtSettle(turn1);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "pauses loudly when git apply rejects the rebuilt diff",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        // Old sides that do not exist at the declared base: apply must fail.
        const badDiff = scriptedConnection([
          diffResult(repos.baseSha, [
            modifiedFile("app.txt", "not\nwhat\nis\nthere\n", "something\n"),
          ]),
        ]);
        const outcome = yield* engine.syncAtSettle(badDiff);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("git apply");
        }
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "pauses loudly when the declared baseRef does not resolve even after fetch",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const unknownBase = scriptedConnection([
          diffResult("0123456789abcdef0123456789abcdef01234567", [
            addedFile("notes.md", "hello\n"),
          ]),
        ]);
        const outcome = yield* engine.syncAtSettle(unknownBase);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("does not resolve");
        }
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "a transport failure mid-request degrades to a warning-level skip, not a pause",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const timedOut = scriptedConnection([
          new AetherWorkspaceRequestTimeoutError({
            channel: "git",
            requestType: "diff",
            requestId: "t3-git-1",
            timeoutMs: 1,
          }),
          // The retry succeeds — self-healing.
          diffResult(repos.baseSha, [addedFile("notes.md", "hello\n")]),
        ]);
        const first = yield* engine.syncAtSettle(timedOut);
        expect(first._tag).toBe("skipped-transport");
        expect(engine.pausedReason()).toBeUndefined();
        const second = yield* engine.syncAtSettle(timedOut);
        expect(second._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("notes.md")).toBe("hello\n");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "binary entries are written from the files channel after the text apply",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const withBinary = scriptedConnection([
          diffResult(repos.baseSha, [
            addedFile("notes.md", "hello\n"),
            {
              oldPath: "assets/logo.bin",
              newPath: "assets/logo.bin",
              displayPath: "assets/logo.bin",
              status: "added",
              isBinary: true,
              hunks: [],
            },
          ]),
        ]);
        const outcome = yield* engine.syncAtSettle(withBinary);
        expect(outcome._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("assets/logo.bin")).toBe("binary:assets/logo.bin");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "refuses binary entries whose diff-supplied path escapes the mirror checkout",
    () =>
      Effect.gen(function* () {
        // Binary entries never pass through `git apply`, so nothing else
        // validates their paths: an absolute newPath makes join(cwd, …)
        // return the path itself, and '..' walks straight out of the
        // checkout. Both must pause loudly with NOTHING touched outside.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const binaryEntry = (entry: {
          readonly oldPath: string;
          readonly newPath: string;
          readonly status: "added" | "deleted";
        }): AetherWsGitDiffFile => ({
          ...entry,
          displayPath: entry.status === "deleted" ? entry.oldPath : entry.newPath,
          isBinary: true,
          hunks: [],
        });

        const escapes: ReadonlyArray<{
          readonly name: string;
          readonly entry: (sentinel: string) => AetherWsGitDiffFile;
        }> = [
          {
            name: "absolute newPath",
            entry: (sentinel) =>
              binaryEntry({ status: "added", oldPath: "/dev/null", newPath: sentinel }),
          },
          {
            name: "'..' newPath",
            entry: () =>
              binaryEntry({ status: "added", oldPath: "/dev/null", newPath: "../escape.bin" }),
          },
          {
            name: "'..' oldPath removal",
            entry: () =>
              binaryEntry({
                status: "deleted",
                oldPath: "../outside-sentinel.txt",
                newPath: "/dev/null",
              }),
          },
          {
            // Repo-relative but git-metadata-targeting: a direct write to
            // .git/hooks/* is code execution on the next git invocation, and
            // git never tracks paths under .git, so no legitimate diff names
            // them.
            name: ".git hooks newPath",
            entry: () =>
              binaryEntry({
                status: "added",
                oldPath: "/dev/null",
                newPath: ".git/hooks/post-checkout",
              }),
          },
          {
            name: ".git config removal",
            entry: () =>
              binaryEntry({
                status: "deleted",
                oldPath: ".git/config",
                newPath: "/dev/null",
              }),
          },
        ];

        for (const escape of escapes) {
          // A fresh repo per case: a pause is sticky, and the previous case
          // left the tree mid-sync.
          const repos = yield* setupRepos;
          const outside = path.dirname(repos.mirror);
          const sentinel = path.join(outside, "outside-sentinel.txt");
          yield* fileSystem.writeFileString(sentinel, "sentinel\n");

          const engine = makeEngine(repos);
          const connection = scriptedConnection([
            diffResult(repos.baseSha, [addedFile("notes.md", "hello\n"), escape.entry(sentinel)]),
          ]);
          const outcome = yield* engine.syncAtSettle(connection);
          expect(outcome, escape.name).toMatchObject({ _tag: "paused", firstPause: true });
          if (outcome._tag === "paused") {
            expect(outcome.reason, escape.name).toContain("escapes the mirror checkout");
          }
          // Nothing outside the checkout was written or deleted.
          expect(yield* fileSystem.readFileString(sentinel)).toBe("sentinel\n");
          expect(yield* fileSystem.exists(path.join(outside, "escape.bin"))).toBe(false);
        }
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "validates every binary path BEFORE any mutation: a rename with a safe oldPath and an escaping newPath removes nothing",
    () =>
      Effect.gen(function* () {
        // The failure mode is partial mutation: oldPath removed, then the
        // newPath validation pauses — a failed sync must never mutate the
        // mirror through its own validation error.
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const connection = scriptedConnection([
          diffResult(repos.baseSha, [
            {
              status: "renamed",
              oldPath: "lib.txt",
              newPath: "../escaped-rename.bin",
              displayPath: "../escaped-rename.bin",
              isBinary: true,
              hunks: [],
            },
          ]),
        ]);
        const outcome = yield* engine.syncAtSettle(connection);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("escapes the mirror checkout");
        }
        // The safe oldPath was NOT removed: validation ran before mutation.
        expect(yield* repos.readMirrorFile("lib.txt")).toBe("lib\n");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "refuses a binary path that reaches outside the checkout THROUGH a symlink",
    () =>
      Effect.gen(function* () {
        // The lexical check passes — `escape-link/payload.bin` has no '..',
        // no leading '/', no '.git'. `writeFile`/`mkdir` FOLLOW the symlink,
        // so before the real-path walk this wrote outside the checkout.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repos = yield* setupRepos;
        const outside = path.dirname(repos.mirror);
        const outsideDir = path.join(outside, "outside-dir");
        yield* fileSystem.makeDirectory(outsideDir, { recursive: true });
        // Planted under the gitignored `build/`, so the link is invisible to
        // the content fingerprint and survives `clean -fd` — exactly how a
        // hostile artifact would sit in a real checkout.
        yield* repos.makeMirrorDirectory("build");
        yield* fileSystem.symlink(outsideDir, path.join(repos.mirror, "build", "escape-link"));

        const engine = makeEngine(repos);
        const outcome = yield* engine.syncAtSettle(
          scriptedConnection([
            diffResult(repos.baseSha, [
              {
                oldPath: "/dev/null",
                newPath: "build/escape-link/payload.bin",
                displayPath: "build/escape-link/payload.bin",
                status: "added",
                isBinary: true,
                hunks: [],
              },
            ]),
          ]),
        );
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("escapes the mirror checkout");
          expect(outcome.reason).toContain("symlink");
        }
        expect(yield* fileSystem.exists(path.join(outsideDir, "payload.bin"))).toBe(false);
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "refuses a binary path whose LEAF is a symlink into the checkout's own .git",
    () =>
      Effect.gen(function* () {
        // Containment alone would let this through: the link's target is
        // inside the checkout. Following it corrupts git metadata, which the
        // lexical '.git' refusal exists to prevent.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repos = yield* setupRepos;
        yield* repos.makeMirrorDirectory("build");
        yield* fileSystem.symlink(
          path.join(repos.mirror, ".git", "config"),
          path.join(repos.mirror, "build", "innocent.bin"),
        );

        const engine = makeEngine(repos);
        const outcome = yield* engine.syncAtSettle(
          scriptedConnection([
            diffResult(repos.baseSha, [
              {
                oldPath: "/dev/null",
                newPath: "build/innocent.bin",
                displayPath: "build/innocent.bin",
                status: "added",
                isBinary: true,
                hunks: [],
              },
            ]),
          ]),
        );
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("escapes the mirror checkout");
          expect(outcome.reason).toContain("symlink");
        }
        expect(yield* repos.readMirrorFile(".git/config")).toContain("[core]");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "removes every old binary path BEFORE writing any new one, so overlapping entries do not clobber",
    () =>
      Effect.gen(function* () {
        // `lib.txt` is BOTH the delete's old path and the rename's new path.
        // Applied entry-by-entry the rename's write landed first and the
        // later delete removed it — and the sync still reported success.
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const outcome = yield* engine.syncAtSettle(
          scriptedConnection([
            diffResult(repos.baseSha, [
              {
                oldPath: "app.txt",
                newPath: "lib.txt",
                displayPath: "lib.txt",
                status: "renamed",
                isBinary: true,
                hunks: [],
              },
              {
                oldPath: "lib.txt",
                newPath: "/dev/null",
                displayPath: "lib.txt",
                status: "deleted",
                isBinary: true,
                hunks: [],
              },
            ]),
          ]),
        );
        expect(outcome._tag).toBe("synced");
        // The rename's target survives: it is written after every removal.
        expect(yield* repos.readMirrorFile("lib.txt")).toBe("binary:lib.txt");
        expect(yield* repos.mirrorFileExists("app.txt")).toBe(false);
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "git-quotes header paths so a name with a quote or backslash still applies",
    () =>
      Effect.gen(function* () {
        // Raw interpolation produced a header `git apply` rejects, which
        // pauses the mirror permanently for the rest of the thread.
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const weird = 'we"ird\\name.txt';
        const outcome = yield* engine.syncAtSettle(
          scriptedConnection([diffResult(repos.baseSha, [addedFile(weird, "quoted\n")])]),
        );
        expect(outcome).toMatchObject({ _tag: "synced" });
        expect(yield* repos.readMirrorFile(weird)).toBe("quoted\n");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "deleted, renamed and dropped entries settle to the EXACT tree each turn",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        yield* repos.makeMirrorDirectory("build");
        yield* repos.writeMirrorFile("build/cache.txt", "artifact\n");

        // -- turn 1: modify app.txt, add notes.md and an EMPTY untracked file.
        const turn1 = scriptedConnection([
          diffResult(repos.baseSha, [
            modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nthree\n"),
            addedFile("notes.md", "hello\n"),
            addedFile("empty.txt", ""),
          ]),
        ]);
        expect((yield* engine.syncAtSettle(turn1))._tag).toBe("synced");
        expect(yield* repos.mirrorTree).toEqual({
          ".gitignore": "build/\n",
          "app.txt": "one\ntwo\nthree\n",
          "lib.txt": "lib\n",
          "notes.md": "hello\n",
          "empty.txt": "",
        });

        // -- turn 2: the agent DELETED app.txt, renamed lib.txt with an
        // edit, and reverted its own notes.md/empty.txt — the cumulative
        // diff simply no longer contains them, so reset+clean must erase
        // them (the whole reason the engine re-baselines every turn).
        const turn2 = scriptedConnection([
          diffResult(repos.baseSha, [
            deletedFile("app.txt", INITIAL_APP),
            renamedFile("lib.txt", "lib/renamed.txt", "lib\n", "lib\nmore\n"),
          ]),
        ]);
        expect((yield* engine.syncAtSettle(turn2))._tag).toBe("synced");
        expect(yield* repos.mirrorTree).toEqual({
          ".gitignore": "build/\n",
          "lib/renamed.txt": "lib\nmore\n",
        });

        // -- turn 3: app.txt restored (dropped from the diff again) and a
        // PURE rename (zero hunks on the wire).
        const turn3 = scriptedConnection([
          diffResult(repos.baseSha, [renamedFile("lib.txt", "moved.txt", "lib\n", "lib\n")]),
        ]);
        expect((yield* engine.syncAtSettle(turn3))._tag).toBe("synced");
        expect(yield* repos.mirrorTree).toEqual({
          ".gitignore": "build/\n",
          "app.txt": INITIAL_APP,
          "moved.txt": "lib\n",
        });
        // The gitignored artifact survived every reset+clean (-fd, never -x).
        expect(yield* repos.readMirrorFile("build/cache.txt")).toBe("artifact\n");
        expect(engine.pausedReason()).toBeUndefined();
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "a mode-only change is skipped with a report — never a pause, never a broken apply",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine = makeEngine(repos);
        const turn = scriptedConnection([
          diffResult(repos.baseSha, [modeOnlyFile("app.txt"), addedFile("notes.md", "hello\n")]),
        ]);
        const outcome = yield* engine.syncAtSettle(turn);
        expect(outcome).toMatchObject({ _tag: "synced", modeOnlySkipped: ["app.txt"] });
        expect(yield* repos.readMirrorFile("app.txt")).toBe(INITIAL_APP);
        expect(yield* repos.readMirrorFile("notes.md")).toBe("hello\n");
        expect(engine.pausedReason()).toBeUndefined();
        // The tree the sync left behind verifies clean on the next settle.
        expect((yield* engine.syncAtSettle(turn))._tag).toBe("synced");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect(
    "crash-resume: the mirror-local fingerprint record recovers a stale or lost cursor",
    () =>
      Effect.gen(function* () {
        const repos = yield* setupRepos;
        const engine1 = makeEngine(repos);
        const turn1 = scriptedConnection([
          diffResult(repos.baseSha, [modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nthree\n")]),
        ]);
        expect((yield* engine1.syncAtSettle(turn1))._tag).toBe("synced");

        // Non-graceful shutdown: the resume cursor never captured turn 1's
        // fingerprint. A fresh engine must NOT read the driver's own applied
        // diff as user divergence — the record written in the same breath as
        // the sync recovers the expected state.
        const engine2 = makeEngine(repos);
        const turn2 = scriptedConnection([
          diffResult(repos.baseSha, [modifiedFile("app.txt", INITIAL_APP, "one\ntwo\nfour\n")]),
        ]);
        expect((yield* engine2.syncAtSettle(turn2))._tag).toBe("synced");
        expect(yield* repos.readMirrorFile("app.txt")).toBe("one\ntwo\nfour\n");

        // A STALE cursor fingerprint loses to the mirror-local record too.
        const engine3 = makeEngine(repos, { persistedFingerprint: "stale:stale" });
        expect((yield* engine3.syncAtSettle(turn2))._tag).toBe("synced");

        // A record from ANOTHER task never vouches for this tree.
        const engine4 = makeEngine(repos, { taskId: "task-other" });
        const outcome = yield* engine4.syncAtSettle(turn2);
        expect(outcome).toMatchObject({ _tag: "paused", firstPause: true });
        if (outcome._tag === "paused") {
          expect(outcome.reason).toContain("diverged");
        }
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
});
