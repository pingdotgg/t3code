// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git and tar directly on real folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  applyWorkFiles,
  archiveStream,
  isSafeRelativePath,
  listArchive,
  selectWorkFiles,
  WORK_FILES_MAX_BYTES,
  WORK_FILES_MAX_COUNT,
} from "./WorkFiles.ts";

// Real git and tar on real directories: both sides of a transfer run the system tools.

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-work-files-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const write = (root: string, path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), content);
};

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();

/** A repository with one commit of `files`. */
const repository = (root: string, files: Record<string, string>) => {
  git(root, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  return git(root, "rev-parse", "HEAD");
};

const tar = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("tar", args, {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

/** The archive the source would send for `files` under `root`, written to `archivePath`. */
const writeArchive = (root: string, files: ReadonlyArray<string>, archivePath: string) =>
  archiveStream(root, files).pipe(
    Stream.runFold(
      () => [] as Uint8Array[],
      (chunks, chunk) => {
        chunks.push(chunk);
        return chunks;
      },
    ),
    Effect.map((chunks) => NodeFS.writeFileSync(archivePath, Buffer.concat(chunks))),
  );

it.live(
  "a git checkout carries its changed, staged, untracked and deleted files, not its secrets",
  () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      const head = repository(root, {
        "src/app.ts": "one",
        "src/old.ts": "old",
        "README.md": "readme",
        ".gitignore": "ignored.log\n",
      });
      write(root, "src/app.ts", "two");
      write(root, "src/staged.ts", "staged");
      git(root, "add", "src/staged.ts");
      write(root, "notes/new.md", "new");
      write(root, "ignored.log", "noise");
      write(root, ".env.local", "TOKEN=1");
      write(root, "certs/server.pem", "pem");
      NodeFS.rmSync(NodePath.join(root, "src/old.ts"));
      NodeFS.symlinkSync("README.md", NodePath.join(root, "link.md"));

      const selection = yield* selectWorkFiles(root);
      expect(selection.head).toBe(head);
      expect(selection.files.map((file) => file.path)).toEqual([
        "notes/new.md",
        "src/app.ts",
        "src/staged.ts",
      ]);
      expect(selection.deletions).toEqual(["src/old.ts"]);
      expect(selection.leftBehind).toEqual([".env.local", "certs/server.pem"]);
      expect(selection.totalBytes).toBe(3 + 3 + 6);
      expect(selection.refusal).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a folder outside git carries every file but dependencies, build output and secrets", () =>
  Effect.gen(function* () {
    const root = yield* tempDir;
    write(root, "index.html", "<p>");
    write(root, "src/main.js", "main");
    write(root, "node_modules/lib/index.js", "lib");
    write(root, "dist/main.js", "built");
    write(root, ".git/HEAD", "not a repository");
    write(root, "id_rsa", "secret");
    write(root, "deploy/.netrc", "secret");

    const selection = yield* selectWorkFiles(root);
    expect(selection.head).toBeNull();
    expect(selection.files.map((file) => file.path)).toEqual(["index.html", "src/main.js"]);
    expect(selection.deletions).toEqual([]);
    expect(selection.leftBehind).toEqual(["deploy/.netrc", "id_rsa"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses a set over either limit with its numbers", () =>
  Effect.gen(function* () {
    const big = yield* tempDir;
    // Sparse, so the test writes no 100 MiB.
    NodeFS.truncateSync(
      (write(big, "huge.bin", ""), NodePath.join(big, "huge.bin")),
      WORK_FILES_MAX_BYTES + 1,
    );
    expect((yield* selectWorkFiles(big)).refusal).toBe(
      "The work files are 1 files and 100.0 MiB; the limit is 5,000 files and 100.0 MiB.",
    );

    const many = yield* tempDir;
    for (let index = 0; index <= WORK_FILES_MAX_COUNT; index++) write(many, `f/${index}`, "");
    expect((yield* selectWorkFiles(many)).refusal).toMatch(
      /^The work files are more than 5,000 files and 0\.0 MiB; the limit is 5,000 files/,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("keeps archive and deletion paths inside the checkout on every platform", () => {
  for (const path of ["/etc/passwd", "../up", "a/../../up", "C:/x", "a\\b", ""]) {
    expect(isSafeRelativePath(path), path).toBe(false);
  }
  for (const path of ["a", "a/b.txt", ".github/x.yml", "a..b"]) {
    expect(isSafeRelativePath(path), path).toBe(true);
  }
});

it.live.each([
  [
    "an absolute path",
    (dir: string) => tar(dir, "-czPf", "bad.tgz", NodePath.join(dir, "src", "x")),
  ],
  [
    "a path with ..",
    (dir: string) => tar(NodePath.join(dir, "src"), "-czPf", "../bad.tgz", "../src/x"),
  ],
  [
    "a symlink",
    (dir: string) => {
      NodeFS.symlinkSync("/etc", NodePath.join(dir, "src", "link"));
      tar(dir, "-czf", "bad.tgz", "src/link");
    },
  ],
  [
    "a hard link",
    (dir: string) => {
      NodeFS.linkSync(NodePath.join(dir, "src", "x"), NodePath.join(dir, "src", "y"));
      tar(dir, "-czf", "bad.tgz", "src/x", "src/y");
    },
  ],
] as const)("refuses an archive with %s", ([, make]) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    write(dir, "src/x", "x");
    make(dir);
    const refused = yield* listArchive(NodePath.join(dir, "bad.tgz"), dir).pipe(Effect.flip);
    expect(refused.reason).toBe("invalid_archive");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** A source and a target checkout of the same commit, and the source's archive of `files`. */
const pair = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const source = yield* tempDir;
    const target = yield* tempDir;
    const scratch = yield* tempDir;
    repository(source, files);
    // A clone, not a copy: git may still be writing objects after the commit.
    git(target, "clone", "-q", source, ".");
    return {
      source,
      target,
      archivePath: NodePath.join(scratch, "work.tgz"),
      stagingDir: NodePath.join(scratch, "staging"),
    };
  });

it.live("applies the work to the same commit there, deletions included", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({
      "a.ts": "a",
      "gone.ts": "g",
    });
    write(source, "a.ts", "changed");
    write(source, "deep/new.ts", "new");
    NodeFS.rmSync(NodePath.join(source, "gone.ts"));
    const selection = yield* selectWorkFiles(source);
    yield* writeArchive(
      source,
      selection.files.map((file) => file.path),
      archivePath,
    );

    const input = {
      archivePath,
      stagingDir,
      root: target,
      head: selection.head,
      deletions: selection.deletions,
    };
    expect(yield* applyWorkFiles(input)).toEqual({ files: 2, deletions: 1 });
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("changed");
    expect(NodeFS.readFileSync(NodePath.join(target, "deep/new.ts"), "utf8")).toBe("new");
    expect(NodeFS.existsSync(NodePath.join(target, "gone.ts"))).toBe(false);
    // The same work again changes nothing and is not a conflict.
    NodeFS.rmSync(stagingDir, { recursive: true });
    expect(yield* applyWorkFiles(input)).toEqual({ files: 2, deletions: 0 });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses a checkout on another commit, naming both", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({ "a.ts": "a" });
    write(target, "b.ts", "b");
    git(target, "add", "b.ts");
    git(target, "commit", "-q", "-m", "ahead");
    write(source, "a.ts", "changed");
    const selection = yield* selectWorkFiles(source);
    yield* writeArchive(source, ["a.ts"], archivePath);

    const refused = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      root: target,
      head: selection.head,
      deletions: [],
    }).pipe(Effect.flip);
    expect(refused.reason).toBe("head_mismatch");
    expect(refused.message).toContain(selection.head!);
    expect(refused.message).toContain(git(target, "rev-parse", "HEAD"));
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("a");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("never overwrites a file with local changes there, and changes nothing", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({
      "a.ts": "a",
      "b.ts": "b",
      "c.ts": "c",
    });
    write(source, "a.ts", "from source");
    write(source, "b.ts", "from source");
    write(source, "new.ts", "from source");
    NodeFS.rmSync(NodePath.join(source, "c.ts"));
    write(target, "b.ts", "edited there");
    write(target, "new.ts", "untracked there");
    write(target, "c.ts", "edited there");
    const selection = yield* selectWorkFiles(source);
    yield* writeArchive(
      source,
      selection.files.map((file) => file.path),
      archivePath,
    );

    const refused = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      root: target,
      head: selection.head,
      deletions: selection.deletions,
    }).pipe(Effect.flip);
    expect(refused.reason).toBe("conflict");
    expect(refused.message).toContain("b.ts (it has local changes there)");
    expect(refused.message).toContain("new.ts (it has local changes there)");
    expect(refused.message).toContain("c.ts (it has local changes there)");
    expect(refused.message).not.toContain("a.ts");
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("a");
    expect(NodeFS.readFileSync(NodePath.join(target, "c.ts"), "utf8")).toBe("edited there");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
