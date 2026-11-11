// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git and cp directly and read raw stat data.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";

import { indexEntryStat, parseIndex, restatIndex } from "./gitIndexStat.ts";

const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });

// A repository whose checkout in `source` was written by Git with its own index, then copied
// to `copy` the way a clone would: same contents and mtimes, new inodes and ctimes.
const makeCopiedCheckout = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-index-stat-"));
    const repo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "filter.probe.clean", "echo read >> ../clean-runs; cat"]);
    NodeFS.writeFileSync(NodePath.join(repo, ".gitattributes"), "*.txt filter=probe\n");
    NodeFS.mkdirSync(NodePath.join(repo, "nested"));
    NodeFS.writeFileSync(NodePath.join(repo, "a.txt"), "alpha\n");
    NodeFS.writeFileSync(NodePath.join(repo, "nested", "b.txt"), "beta\n");
    NodeFS.writeFileSync(NodePath.join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    NodeFS.symlinkSync("a.txt", NodePath.join(repo, "link"));
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    const source = NodePath.join(root, "source");
    const sourceIndex = NodePath.join(root, "source.index");
    NodeFS.mkdirSync(source);
    const env = { GIT_INDEX_FILE: sourceIndex };
    git(
      repo,
      ["-c", "index.version=2", `--work-tree=${source}`, "read-tree", "--reset", "-u", tree],
      env,
    );
    // Old mtimes keep every entry clear of Git's racy-clean re-read.
    for (const name of ["a.txt", "nested/b.txt", "run.sh", ".gitattributes"]) {
      NodeFS.utimesSync(NodePath.join(source, name), 1_000_000, 1_000_000);
    }
    git(
      repo,
      ["-c", "index.version=2", `--work-tree=${source}`, "update-index", "-q", "--refresh"],
      env,
    );
    const copy = NodePath.join(root, "copy");
    NodeChildProcess.execFileSync("cp", ["-a", source, copy]);
    // Setup ran the filter itself; only reads after this point count.
    NodeFS.rmSync(NodePath.join(root, "clean-runs"), { force: true });
    return { root, repo, source, sourceIndex, copy };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const statAll = (root: string, paths: ReadonlyArray<string>) =>
  paths.map((entryPath) => {
    try {
      return indexEntryStat(NodeFS.lstatSync(NodePath.join(root, entryPath), { bigint: true }));
    } catch {
      return undefined;
    }
  });

// The feature is macOS-only; the fixtures need symlinks.
describe.skipIf(!symlinksSupported)("restatIndex", () => {
  it.effect("makes Git trust copied files without reading them", () =>
    Effect.gen(function* () {
      const { root, repo, sourceIndex, copy } = yield* makeCopiedCheckout;
      const parsed = parseIndex(NodeFS.readFileSync(sourceIndex));
      assert.isNotNull(parsed);
      const paths = parsed!.entries.map((entry) => entry.path);
      assert.deepStrictEqual(paths, [".gitattributes", "a.txt", "link", "nested/b.txt", "run.sh"]);

      const restated = restatIndex(parsed!, statAll(copy, paths), { verify: true });
      assert.isNotNull(restated);
      const copyIndex = NodePath.join(root, "copy.index");
      NodeFS.writeFileSync(copyIndex, restated!);
      const status = git(
        repo,
        [`--work-tree=${copy}`, "status", "--porcelain", "--untracked-files=no"],
        {
          GIT_INDEX_FILE: copyIndex,
        },
      );
      assert.equal(status, "");
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "clean-runs")));
    }),
  );

  it.effect("rejects a copy whose file no longer matches what Git recorded", () =>
    Effect.gen(function* () {
      const { sourceIndex, copy } = yield* makeCopiedCheckout;
      const parsed = parseIndex(NodeFS.readFileSync(sourceIndex))!;
      const paths = parsed.entries.map((entry) => entry.path);
      NodeFS.writeFileSync(NodePath.join(copy, "a.txt"), "ALPHA\n");
      assert.isNull(restatIndex(parsed, statAll(copy, paths), { verify: true }));
      assert.isNotNull(restatIndex(parsed, statAll(copy, paths), { verify: false }));
    }),
  );

  it.effect("rejects two tracked paths that are one file, as on a case-insensitive volume", () =>
    Effect.gen(function* () {
      const { sourceIndex, copy } = yield* makeCopiedCheckout;
      const parsed = parseIndex(NodeFS.readFileSync(sourceIndex))!;
      const paths = parsed.entries.map((entry) => entry.path);
      NodeFS.rmSync(NodePath.join(copy, "nested", "b.txt"));
      NodeFS.linkSync(NodePath.join(copy, "a.txt"), NodePath.join(copy, "nested", "b.txt"));
      assert.isNull(restatIndex(parsed, statAll(copy, paths), { verify: false }));
    }),
  );

  it.effect("leaves indexes it cannot rewrite safely to Git", () =>
    Effect.gen(function* () {
      const { repo, source, sourceIndex } = yield* makeCopiedCheckout;
      const env = { GIT_INDEX_FILE: sourceIndex };
      git(repo, [`--work-tree=${source}`, "update-index", "--index-version", "4"], env);
      assert.isNull(parseIndex(NodeFS.readFileSync(sourceIndex)));
    }),
  );
});
