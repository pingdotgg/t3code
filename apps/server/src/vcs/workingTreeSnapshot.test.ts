// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git and read the copied files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { copyWorkingTreeSnapshot, namedInBrief, untrackedPaths } from "./workingTreeSnapshot.ts";

const dirs: string[] = [];

const removeDirs = () =>
  Effect.promise(() =>
    Promise.all(dirs.splice(0).map((dir) => NodeFS.rm(dir, { recursive: true, force: true }))),
  );

it.effect("a path token matches the file or its directory", () =>
  Effect.sync(() => {
    assert.strictEqual(namedInBrief("notes/a.txt", "Read notes/a.txt now"), true);
    assert.strictEqual(namedInBrief("notes/a.txt", "Read notes/ now"), true);
    assert.strictEqual(namedInBrief("notes/a.txt", "release notes"), false);
    assert.strictEqual(namedInBrief("README.md", "Open README.md"), true);
  }),
);

it.effect("status lines yield only untracked paths", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(untrackedPaths(" M tracked.txt\0?? notes/a.txt\0?? ../escape\0"), [
      "notes/a.txt",
    ]);
  }),
);

it.effect("the child receives the parent's tracked edits and a named untracked file", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(tempRepo);
    yield* Effect.promise(() => NodeFS.writeFile(NodePath.join(root, "tracked.txt"), "old\n"));
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "base"]);
    const child = `${root}-child`;
    dirs.push(child);
    git(root, ["worktree", "add", "--no-checkout", "-b", "child", child, "HEAD"]);
    git(child, ["checkout", "HEAD"]);
    yield* Effect.promise(() => NodeFS.writeFile(NodePath.join(root, "tracked.txt"), "new\n"));
    yield* Effect.promise(() => NodeFS.mkdir(NodePath.join(root, "notes")));
    yield* Effect.promise(() =>
      NodeFS.writeFile(NodePath.join(root, "notes", "a.txt"), "named\n"),
    );
    yield* Effect.promise(() => NodeFS.writeFile(NodePath.join(root, "secret.txt"), "hidden\n"));
    const modules = NodePath.join(root, "node_modules");
    yield* Effect.promise(() => NodeFS.mkdir(modules));
    yield* Effect.promise(() => NodeFS.writeFile(NodePath.join(modules, "pkg.js"), "nope\n"));

    yield* Effect.promise(() =>
      copyWorkingTreeSnapshot({
        parentCwd: root,
        childCwd: child,
        brief: "Explain notes/a.txt and node_modules/pkg.js",
      }),
    );

    assert.strictEqual(
      yield* Effect.promise(() => NodeFS.readFile(NodePath.join(child, "tracked.txt"), "utf8")),
      "new\n",
    );
    assert.strictEqual(
      yield* Effect.promise(() =>
        NodeFS.readFile(NodePath.join(child, "notes", "a.txt"), "utf8"),
      ),
      "named\n",
    );
    assert.strictEqual(
      yield* Effect.promise(() =>
        NodeFS.readFile(NodePath.join(child, "secret.txt"), "utf8").then(
          () => "present",
          () => "absent",
        ),
      ),
      "absent",
    );
    assert.strictEqual(
      yield* Effect.promise(() =>
        NodeFS.readFile(NodePath.join(child, "node_modules", "pkg.js"), "utf8").then(
          () => "present",
          () => "absent",
        ),
      ),
      "absent",
    );

    yield* Effect.promise(() => NodeFS.writeFile(NodePath.join(root, "tracked.txt"), "later\n"));
    assert.strictEqual(
      yield* Effect.promise(() => NodeFS.readFile(NodePath.join(child, "tracked.txt"), "utf8")),
      "new\n",
    );
  }).pipe(Effect.ensuring(removeDirs)),
);

function tempRepo(): Promise<string> {
  return NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "snapshot-")).then((dir) => {
    dirs.push(dir);
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "snapshot@example.com"]);
    git(dir, ["config", "user.name", "Snapshot"]);
    return dir;
  });
}

function git(cwd: string, args: string[]): void {
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}
