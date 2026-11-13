// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git and tar directly on real folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

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

/** One ustar entry: a header with `name` and `type`, then `body` padded to a block. */
const tarEntry = (name: string, type: string, body: Buffer) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write("ustar\u000000", 257, "binary");
  header.fill(" ", 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
};

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
  "a git checkout carries its changed, staged, untracked and deleted files, secrets included",
  () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      const head = repository(root, {
        "src/app.ts": "one",
        "src/old.ts": "old",
        "README.md": "readme",
        ".gitignore": "ignored.log\n",
        "config/.env": "TOKEN=0",
      });
      write(root, "src/app.ts", "two");
      write(root, "src/staged.ts", "staged");
      git(root, "add", "src/staged.ts");
      write(root, "notes/new.md", "new");
      write(root, "ignored.log", "noise");
      write(root, ".env.local", "TOKEN=1");
      write(root, "certs/server.pem", "pem");
      NodeFS.rmSync(NodePath.join(root, "src/old.ts"));
      NodeFS.rmSync(NodePath.join(root, "config/.env"));
      NodeFS.symlinkSync("README.md", NodePath.join(root, "link.md"));

      const selection = yield* selectWorkFiles(root);
      expect(selection.head).toBe(head);
      expect(selection.files.map((file) => file.path)).toEqual([
        ".env.local",
        "certs/server.pem",
        "notes/new.md",
        "src/app.ts",
        "src/staged.ts",
      ]);
      expect(selection.deletions).toEqual(["config/.env", "src/old.ts"]);
      expect(selection.totalBytes).toBe(7 + 3 + 3 + 3 + 6);
      expect(selection.refusal).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a folder outside git carries every file but dependencies and build output", () =>
  Effect.gen(function* () {
    const root = yield* tempDir;
    write(root, "index.html", "<p>");
    write(root, "src/main.js", "main");
    write(root, "node_modules/lib/index.js", "lib");
    write(root, "dist/main.js", "built");
    write(root, ".git/HEAD", "not a repository");
    write(root, "vendor/.GIT/hooks/post-checkout", "hook");
    write(root, "id_rsa", "secret");
    write(root, "deploy/.netrc", "secret");

    const selection = yield* selectWorkFiles(root);
    expect(selection.head).toBeNull();
    expect(selection.files.map((file) => file.path)).toEqual([
      "deploy/.netrc",
      "id_rsa",
      "index.html",
      "src/main.js",
    ]);
    expect(selection.deletions).toEqual([]);
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
  for (const path of [
    "/etc/passwd",
    "../up",
    "a/../../up",
    "C:/x",
    "a\\b",
    "",
    ".git/hooks/post-checkout",
    ".GIT/config",
    "sub/.Git/hooks/pre-commit",
    // Names Windows resolves to .git.
    ".git./hooks/post-checkout",
    ".git /config",
    ".git::$INDEX_ALLOCATION/hooks/post-checkout",
    "GIT~1/config",
    "sub/git~2/hooks/pre-commit",
    ".Git. ./config",
  ]) {
    expect(isSafeRelativePath(path), path).toBe(false);
  }
  for (const path of [
    "a",
    "a/b.txt",
    ".github/x.yml",
    "a..b",
    ".gitignore",
    "x.git/y",
    // Ordinary names that only look odd on Windows still travel.
    "log-10:30.txt",
    "draft.",
    "notes ",
    "a/b:stream",
  ]) {
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
    "a git hook",
    (dir: string) => {
      write(dir, ".git/hooks/post-checkout", "#!/bin/sh\n");
      tar(dir, "-czf", "bad.tgz", "src/x", ".git/hooks/post-checkout");
    },
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
    const refused = yield* listArchive(NodePath.join(dir, "bad.tgz")).pipe(Effect.flip);
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
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
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
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
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
      "d.ts": "d",
      "e.ts": "e",
      "f.ts": "f",
    });
    const outside = yield* tempDir;
    write(source, "a.ts", "from source");
    write(source, "d.ts", "from source");
    write(source, "e.ts", "from source");
    write(source, "f.ts", "from source");
    // Deleted there, unstaged and staged: the source's edit must not bring them back.
    NodeFS.rmSync(NodePath.join(target, "d.ts"));
    git(target, "rm", "-q", "e.ts");
    // Another name for f.ts outside the checkout would change with it.
    NodeFS.linkSync(NodePath.join(target, "f.ts"), NodePath.join(outside, "f.ts"));
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
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
      root: target,
      head: selection.head,
      deletions: selection.deletions,
    }).pipe(Effect.flip);
    expect(refused.reason).toBe("conflict");
    expect(refused.message).toContain("b.ts (it has local changes there)");
    expect(refused.message).toContain("new.ts (it has local changes there)");
    expect(refused.message).toContain("c.ts (it has local changes there)");
    expect(refused.message).toContain("d.ts (it was deleted there)");
    expect(refused.message).toContain("e.ts (it was deleted there)");
    expect(refused.message).toContain("f.ts (it is a hard link to another file there)");
    expect(refused.message).not.toContain("a.ts");
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("a");
    expect(NodeFS.readFileSync(NodePath.join(target, "c.ts"), "utf8")).toBe("edited there");
    expect(NodeFS.existsSync(NodePath.join(target, "d.ts"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(outside, "f.ts"), "utf8")).toBe("f");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a write or delete that fails partway puts back every file it changed", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({
      "a.ts": "a",
      "gone.ts": "gone",
      "locked/z.ts": "z",
    });
    write(source, "a.ts", "changed");
    write(source, "deep/new/file.ts", "new");
    NodeFS.rmSync(NodePath.join(source, "gone.ts"));
    NodeFS.rmSync(NodePath.join(source, "locked/z.ts"));
    const selection = yield* selectWorkFiles(source);
    expect(selection.deletions).toEqual(["gone.ts", "locked/z.ts"]);
    yield* writeArchive(
      source,
      selection.files.map((file) => file.path),
      archivePath,
    );
    // The last deletion fails, after the writes and the first deletion ran.
    const locked = NodePath.join(target, "locked");
    NodeFS.chmodSync(locked, 0o500);
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(locked, 0o700)));

    const refused = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
      root: target,
      head: selection.head,
      deletions: selection.deletions,
    }).pipe(Effect.flip);
    expect(refused.message).toBe("Could not delete locked/z.ts there; nothing was changed there.");
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("a");
    expect(NodeFS.readFileSync(NodePath.join(target, "gone.ts"), "utf8")).toBe("gone");
    expect(NodeFS.existsSync(NodePath.join(target, "deep"))).toBe(false);
    expect(git(target, "status", "--porcelain")).toBe("");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a rollback that cannot put a file back keeps its backup and names where", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({ "ro.ts": "original" });
    write(source, "ro.ts", "changed");
    yield* writeArchive(source, ["ro.ts"], archivePath);
    // Writing fails, and so does putting the backup back.
    const readOnly = NodePath.join(target, "ro.ts");
    NodeFS.chmodSync(readOnly, 0o444);
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(readOnly, 0o644)));
    const keptBackupsDir = NodePath.join(stagingDir, "..", "kept");

    const refused = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      keptBackupsDir,
      root: target,
      head: git(source, "rev-parse", "HEAD"),
      deletions: [],
    }).pipe(Effect.flip);
    const [kept] = NodeFS.readdirSync(keptBackupsDir);
    const keptPath = NodePath.join(keptBackupsDir, kept!);
    expect(refused.message).toContain("could not put back ro.ts");
    expect(refused.message).toContain(keptPath);
    expect(NodeFS.readFileSync(NodePath.join(keptPath, "ro.ts"), "utf8")).toBe("original");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an apply interrupted while it copies finishes the copy before it ends", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({ "a.ts": "a" });
    const paths = Array.from({ length: 200 }, (_, index) => `many/${index}.ts`);
    for (const path of paths) write(source, path, "new");
    yield* writeArchive(source, paths, archivePath);
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const tracer = Tracer.make({
      span(options) {
        if (options.name === "WorkFiles.copyIn") locked();
        return new Tracer.NativeSpan(options);
      },
    });

    const fiber = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
      root: target,
      head: git(source, "rev-parse", "HEAD"),
      deletions: [],
    }).pipe(Effect.withTracer(tracer), Effect.forkChild);
    yield* Effect.promise(() => lockTaken);
    // The caller removes staging once this returns, so the copy must be over.
    yield* Fiber.interrupt(fiber);
    for (const path of paths) {
      expect(NodeFS.readFileSync(NodePath.join(target, path), "utf8"), path).toBe("new");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses deletions from a folder outside git, and applies a secret file's deletion", () =>
  Effect.gen(function* () {
    const target = yield* tempDir;
    const scratch = yield* tempDir;
    write(target, "a.ts", "a");
    write(scratch, "empty/keep.ts", "k");
    const archivePath = NodePath.join(scratch, "work.tgz");
    yield* writeArchive(NodePath.join(scratch, "empty"), ["keep.ts"], archivePath);
    const input = {
      archivePath,
      stagingDir: NodePath.join(scratch, "staging"),
      keptBackupsDir: NodePath.join(scratch, "kept"),
      root: target,
      head: null,
      deletions: ["a.ts"],
    };
    const outsideGit = yield* applyWorkFiles(input).pipe(Effect.flip);
    expect(outsideGit.reason).toBe("invalid_archive");
    expect(NodeFS.readFileSync(NodePath.join(target, "a.ts"), "utf8")).toBe("a");

    const {
      source,
      target: checkout,
      stagingDir,
    } = yield* pair({
      "a.ts": "a",
      "config/.env": "TOKEN=0",
    });
    const applied = yield* applyWorkFiles({
      ...input,
      stagingDir,
      root: checkout,
      head: git(source, "rev-parse", "HEAD"),
      deletions: ["config/.env"],
    });
    expect(applied).toEqual({ files: 1, deletions: 1 });
    expect(NodeFS.existsSync(NodePath.join(checkout, "config/.env"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reads non-ASCII and long names from the archive itself", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({ "a.ts": "a" });
    const prefixed = `${"p".repeat(120)}/${"n".repeat(30)}.md`;
    const long = `${"l".repeat(90)}/${"o".repeat(90)}/${"g".repeat(90)}/${"x".repeat(90)}.md`;
    write(source, "café.md", "c");
    write(source, prefixed, "p");
    write(source, long, "l");
    const selection = yield* selectWorkFiles(source);
    yield* writeArchive(
      source,
      selection.files.map((file) => file.path),
      archivePath,
    );
    expect(selection.files.map((file) => file.path.normalize("NFC")).toSorted()).toEqual(
      [long, prefixed, "café.md"].toSorted(),
    );
    expect((yield* listArchive(archivePath)).map((file) => file.path)).toEqual(
      selection.files.map((file) => file.path),
    );
    expect(
      yield* applyWorkFiles({
        archivePath,
        stagingDir,
        keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
        root: target,
        head: selection.head,
        deletions: [],
      }),
    ).toEqual({ files: 3, deletions: 0 });
    expect(NodeFS.readFileSync(NodePath.join(target, "café.md"), "utf8")).toBe("c");
    expect(NodeFS.readFileSync(NodePath.join(target, long), "utf8")).toBe("l");

    // GNU tar's own long-name entry, as Linux writes it.
    const gnu = NodePath.join(stagingDir, "..", "gnu.tgz");
    const gnuName = `${"g".repeat(150)}/naïve.md`;
    NodeFS.writeFileSync(
      gnu,
      NodeZlib.gzipSync(
        Buffer.concat([
          tarEntry("././@LongLink", "L", Buffer.from(`${gnuName}\0`)),
          tarEntry(gnuName.slice(0, 100), "0", Buffer.from("body")),
          Buffer.alloc(1024),
        ]),
      ),
    );
    expect((yield* listArchive(gnu)).map((file) => file.path)).toEqual([gnuName]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses a global pax header, which GNU tar applies to every entry after it", () =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const archive = NodePath.join(dir, "global.tgz");
    // Lists as one empty file, yet GNU tar would extract 150 MiB of what follows.
    NodeFS.writeFileSync(
      archive,
      NodeZlib.gzipSync(
        Buffer.concat([
          tarEntry("pax_global_header", "g", Buffer.from("18 size=157286400\n")),
          tarEntry("empty.txt", "0", Buffer.alloc(0)),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const refused = yield* listArchive(archive).pipe(Effect.flip);
    expect(refused.reason).toBe("invalid_archive");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses an archive that expands past the size limit before extracting it", () =>
  Effect.gen(function* () {
    const { source, target, archivePath, stagingDir } = yield* pair({ "a.ts": "a" });
    // Sparse, so the test writes no 100 MiB; it gzips to well under a megabyte.
    write(source, "huge.bin", "");
    NodeFS.truncateSync(NodePath.join(source, "huge.bin"), WORK_FILES_MAX_BYTES + 1);
    yield* writeArchive(source, ["huge.bin"], archivePath);

    const refused = yield* applyWorkFiles({
      archivePath,
      stagingDir,
      keptBackupsDir: NodePath.join(stagingDir, "..", "kept"),
      root: target,
      head: git(source, "rev-parse", "HEAD"),
      deletions: [],
    }).pipe(Effect.flip);
    expect(refused.reason).toBe("over_limit");
    expect(NodeFS.existsSync(stagingDir)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(target, "huge.bin"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("transfers into one checkout apply one at a time", () =>
  Effect.gen(function* () {
    const { source, target } = yield* pair({ "a.ts": "a" });
    const head = git(source, "rev-parse", "HEAD");
    const sends = yield* Effect.forEach(
      Array.from({ length: 12 }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const dir = yield* tempDir;
          write(source, "new.ts", `send ${index}`);
          yield* writeArchive(source, ["new.ts"], NodePath.join(dir, "work.tgz"));
          return {
            archivePath: NodePath.join(dir, "work.tgz"),
            stagingDir: NodePath.join(dir, "staging"),
            keptBackupsDir: NodePath.join(dir, "kept"),
            // The same checkout, named another way by every other send.
            root: index % 2 === 0 ? target : `${target}/.`,
            head,
            deletions: [],
          };
        }),
    );

    const results = yield* Effect.forEach(sends, (input) => Effect.result(applyWorkFiles(input)), {
      concurrency: "unbounded",
    });
    // The first to apply wins; every later one sees its file as local work.
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
