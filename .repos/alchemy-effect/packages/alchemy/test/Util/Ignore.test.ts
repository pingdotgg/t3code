import { describe, expect, it, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  combineIgnoreRules,
  type IgnoreDialect,
  listFileSystemDirectory,
  parseIgnoreRules,
  walkIgnoring,
  type WalkEntryType,
} from "@/Util/Ignore.ts";

// ---------------------------------------------------------------------------
// In-memory file trees
//
//   "a/b.txt"           a file (parents are implied)
//   "a/empty/"          an empty directory
//   "a/link -> ../x"    a symlink
//   "locked/!"          an unreadable directory: listing it fails
// ---------------------------------------------------------------------------

interface Tree {
  readonly children: Map<string, Map<string, WalkEntryType>>;
  readonly links: Map<string, string>;
  readonly unreadable: Set<string>;
}

const tree = (...entries: string[]): Tree => {
  const children = new Map<string, Map<string, WalkEntryType>>([["", new Map()]]);
  const links = new Map<string, string>();
  const unreadable = new Set<string>();
  const add = (path: string, type: WalkEntryType) => {
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const self = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1;
      children.get(parent)!.set(parts[index], isLeaf ? type : "Directory");
      if (!isLeaf || type === "Directory") {
        if (!children.has(self)) children.set(self, new Map());
      }
    }
  };
  for (const entry of entries) {
    if (entry.endsWith("/!")) {
      const directory = entry.slice(0, -2);
      add(directory, "Directory");
      unreadable.add(directory);
    } else if (entry.includes(" -> ")) {
      const [path, target] = entry.split(" -> ");
      add(path, "SymbolicLink");
      links.set(path, target);
    } else if (entry.endsWith("/")) {
      add(entry.slice(0, -1), "Directory");
    } else {
      add(entry, "File");
    }
  }
  return { children, links, unreadable };
};

/** Walk an in-memory tree, recording which directories were read. */
const walkTree = (fileTree: Tree, ignore: string, dialect: IgnoreDialect, force: string[] = []) =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const entries = yield* walkIgnoring({
      rules: parseIgnoreRules(ignore, dialect),
      force,
      list: (directory) =>
        Effect.suspend(() => {
          reads.push(directory);
          if (fileTree.unreadable.has(directory)) {
            return Effect.fail(`EACCES: ${directory}`);
          }
          return Effect.succeed(
            [...fileTree.children.get(directory)!].map(([name, type]) => ({ name, type })),
          );
        }),
    });
    return {
      kept: entries.map((entry) => (entry.type === "Directory" ? `${entry.path}/` : entry.path)),
      files: entries.filter((entry) => entry.type !== "Directory").map((entry) => entry.path),
      reads,
    };
  });

interface Case {
  readonly name: string;
  readonly ignore: string;
  readonly tree: string[];
  /** Expected non-directory entries kept by the walk. */
  readonly files: string[];
  /** Directories the walk must never read. */
  readonly notRead?: string[];
}

// ---------------------------------------------------------------------------
// gitignore
// ---------------------------------------------------------------------------

const gitignoreCases: Case[] = [
  {
    name: "a bare name matches at any depth",
    ignore: "foo\n",
    tree: ["foo", "a/foo", "b/c/foo", "a/bar"],
    files: [".gitignore", "a/bar"],
  },
  {
    name: "a leading slash anchors to the root",
    ignore: "/foo\n",
    tree: ["foo", "a/foo"],
    files: [".gitignore", "a/foo"],
  },
  {
    name: "a trailing slash matches directories only",
    ignore: "build/\n",
    tree: ["build/x", "a/build/y", "lib/build"],
    files: [".gitignore", "lib/build"],
    notRead: ["build", "a/build"],
  },
  {
    name: "a wildcard matches at any depth",
    ignore: "*.log\n",
    tree: ["x.log", "a/b.log", "a.txt"],
    files: [".gitignore", "a.txt"],
  },
  {
    name: "a later negation re-includes a file",
    ignore: "*.log\n!keep.log\n",
    tree: ["x.log", "keep.log", "a/keep.log", "a/y.log"],
    files: [".gitignore", "a/keep.log", "keep.log"],
  },
  {
    name: "nothing below an excluded directory can be re-included",
    ignore: "logs/\n!logs/keep.log\n",
    tree: ["logs/keep.log", "logs/x.log", "app.ts"],
    files: [".gitignore", "app.ts"],
    notRead: ["logs"],
  },
  {
    name: "excluding a directory's contents allows re-inclusion",
    ignore: "logs/*\n!logs/keep.log\n",
    tree: ["logs/keep.log", "logs/x.log"],
    files: [".gitignore", "logs/keep.log"],
  },
  {
    name: "**/ matches the directory at any depth",
    ignore: "**/cache\n",
    tree: ["cache/a", "x/cache/b", "x/y/cache/c", "x/keep"],
    files: [".gitignore", "x/keep"],
    notRead: ["cache", "x/cache", "x/y/cache"],
  },
  {
    name: "/**/ spans zero or more directories",
    ignore: "a/**/b\n",
    tree: ["a/b", "a/x/b", "a/x/y/b", "c/a/b"],
    files: [".gitignore", "c/a/b"],
  },
  {
    name: "a single * does not cross directories",
    ignore: "doc/*.txt\n",
    tree: ["doc/x.txt", "doc/sub/y.txt"],
    files: [".gitignore", "doc/sub/y.txt"],
  },
  {
    name: "a pattern with an inner slash is anchored to the root",
    ignore: "a/b\n",
    tree: ["a/b", "x/a/b"],
    files: [".gitignore", "x/a/b"],
  },
  {
    name: "comments, blank lines, and escaped #",
    ignore: "# comment\n\n\\#hash\n",
    tree: ["#hash", "# comment", "keep"],
    files: ["# comment", ".gitignore", "keep"],
  },
  {
    name: "character classes and ?",
    ignore: "file[0-9].txt\na?.md\n",
    tree: ["file1.txt", "fileA.txt", "ab.md", "abc.md"],
    files: [".gitignore", "abc.md", "fileA.txt"],
  },
  {
    name: "the ignore file can exclude itself",
    ignore: ".gitignore\nsecret\n",
    tree: ["secret", "public"],
    files: ["public"],
  },
];

// ---------------------------------------------------------------------------
// dockerignore
// ---------------------------------------------------------------------------

const dockerignoreCases: Case[] = [
  {
    name: "a bare name matches only at the root",
    ignore: "foo\n",
    tree: ["foo", "a/foo", "a/bar"],
    files: [".dockerignore", "a/bar", "a/foo"],
  },
  {
    name: "**/ matches at any depth",
    ignore: "**/foo\n",
    tree: ["foo", "a/foo", "a/b/foo", "a/bar"],
    files: [".dockerignore", "a/bar"],
  },
  {
    name: "a wildcard matches only at the root",
    ignore: "*.log\n",
    tree: ["x.log", "a/b.log", "a.txt"],
    files: [".dockerignore", "a.txt", "a/b.log"],
  },
  {
    name: "a later negation re-includes below an excluded directory",
    ignore: "logs\n!logs/keep.log\n",
    tree: ["logs/keep.log", "logs/x.log", "app.ts"],
    files: [".dockerignore", "app.ts", "logs/keep.log"],
  },
  {
    name: "an excluded directory is not read",
    ignore: "node_modules\n",
    tree: ["node_modules/pkg/index.js", "src/index.ts"],
    files: [".dockerignore", "src/index.ts"],
    notRead: ["node_modules"],
  },
  {
    name: "dir/** prunes the directory",
    ignore: "node_modules/**\n",
    tree: ["node_modules/pkg/index.js", "src/index.ts"],
    files: [".dockerignore", "src/index.ts"],
    notRead: ["node_modules"],
  },
  {
    name: "a negation elsewhere does not stop pruning",
    ignore: "ignored\n!other/keep\n",
    tree: ["ignored/deep/x", "other/keep", "other/drop"],
    files: [".dockerignore", "other/drop", "other/keep"],
    notRead: ["ignored"],
  },
  {
    name: "the last matching rule wins",
    ignore: "!keep.txt\n*.txt\n",
    tree: ["keep.txt", "drop.txt", "a.md"],
    files: [".dockerignore", "a.md"],
  },
  {
    name: "an allowlist re-includes one subtree",
    ignore: "**\n!src\n",
    tree: ["src/index.ts", "src/lib/a.ts", "docs/readme.md", "package.json"],
    files: ["src/index.ts", "src/lib/a.ts"],
    notRead: ["docs"],
  },
  {
    name: "leading / and ./ are stripped",
    ignore: "/foo\n./bar\n",
    tree: ["foo", "bar", "a/foo"],
    files: [".dockerignore", "a/foo"],
  },
  {
    name: "a trailing slash also matches a file",
    ignore: "build/\n",
    tree: ["build", "lib/build"],
    files: [".dockerignore", "lib/build"],
  },
  {
    name: "/**/ spans zero or more directories",
    ignore: "a/**/b\n",
    tree: ["a/b", "a/x/b", "a/x/y/b", "c/a/b"],
    files: [".dockerignore", "c/a/b"],
  },
  {
    name: "comments and escaped !",
    ignore: "# comment\n\\!bang\n",
    tree: ["!bang", "# comment", "keep"],
    files: ["# comment", ".dockerignore", "keep"],
  },
  {
    name: "the ignore file can exclude itself",
    ignore: ".dockerignore\nsecret\n",
    tree: ["secret", "public"],
    files: ["public"],
  },
];

const withIgnoreFile = (dialect: IgnoreDialect, testCase: Case) =>
  tree(dialect === "gitignore" ? ".gitignore" : ".dockerignore", ...testCase.tree);

describe("Ignore rules (in-memory trees)", { tags: ["unit", "local"] }, () => {
  for (const [dialect, cases] of [
    ["gitignore", gitignoreCases],
    ["dockerignore", dockerignoreCases],
  ] as const) {
    describe(dialect, () => {
      for (const testCase of cases) {
        it.effect(testCase.name, () =>
          Effect.gen(function* () {
            const { files, reads } = yield* walkTree(
              withIgnoreFile(dialect, testCase),
              testCase.ignore,
              dialect,
            );
            expect(files).toEqual([...testCase.files].sort());
            for (const directory of testCase.notRead ?? []) {
              expect(reads).not.toContain(directory);
            }
          }),
        );
      }
    });
  }

  describe("dialects disagree", () => {
    for (const [name, ignore, files, git, docker] of [
      ["bare name depth", "foo\n", ["foo", "a/foo"], [], ["a/foo"]],
      ["wildcard depth", "*.log\n", ["x.log", "a/y.log"], [], ["a/y.log"]],
      [
        "re-including below an excluded directory",
        "logs\n!logs/keep.log\n",
        ["logs/keep.log", "logs/x.log"],
        [],
        ["logs/keep.log"],
      ],
    ] as const) {
      it.effect(name, () =>
        Effect.gen(function* () {
          const kept = (dialect: IgnoreDialect) =>
            walkTree(tree(...files), ignore, dialect).pipe(Effect.map((result) => result.files));
          expect(yield* kept("gitignore")).toEqual([...git]);
          expect(yield* kept("dockerignore")).toEqual([...docker]);
        }),
      );
    }
  });

  describe("walking", () => {
    it.effect("never reads an excluded, unreadable directory", () =>
      Effect.gen(function* () {
        for (const dialect of ["gitignore", "dockerignore"] as const) {
          const { files } = yield* walkTree(
            tree("data/postgres/!", "src/index.ts"),
            "data\n",
            dialect,
          );
          expect(files).toEqual(["src/index.ts"]);
        }
      }),
    );

    it.effect("fails on an unreadable directory that is not excluded", () =>
      Effect.gen(function* () {
        const error = yield* walkTree(tree("data/!", "src/index.ts"), "", "dockerignore").pipe(
          Effect.flip,
        );
        expect(error).toBe("EACCES: data");
      }),
    );

    it.effect("lists symlinks as links and never follows them", () =>
      Effect.gen(function* () {
        const { kept, reads } = yield* walkTree(
          tree("app/node_modules -> ../node_modules", "node_modules/pkg/index.js", "loop -> ."),
          "",
          "dockerignore",
        );
        expect(kept).toContain("app/node_modules");
        expect(kept).toContain("loop");
        expect(reads).not.toContain("loop");
        expect(reads).not.toContain("app/node_modules");
      }),
    );

    it.effect("lists empty and excluded-but-walked directories correctly", () =>
      Effect.gen(function* () {
        const { kept } = yield* walkTree(
          tree("empty/", "logs/keep.log", "logs/x.log"),
          "logs\n!logs/keep.log\n",
          "dockerignore",
        );
        // `logs` itself is excluded but walked; `empty` is kept.
        expect(kept).toEqual(["empty/", "logs/keep.log"]);
      }),
    );

    it.effect("forced paths are kept and their parents are never pruned", () =>
      Effect.gen(function* () {
        const { files } = yield* walkTree(
          tree("build/Dockerfile", "build/out.js"),
          "build\n",
          "dockerignore",
          ["build/Dockerfile"],
        );
        expect(files).toEqual(["build/Dockerfile"]);
      }),
    );

    it.effect("combines rule sets anchored at different directories", () =>
      Effect.gen(function* () {
        // The walk root is `packages/app`; the repository root ignores
        // `/packages/app/dist` and `*.log`, the app ignores `.cache`.
        const rules = combineIgnoreRules("gitignore", [
          parseIgnoreRules("/packages/app/dist\n*.log\n", "gitignore", {
            prefix: "packages/app",
          }),
          parseIgnoreRules(".cache\n", "gitignore"),
        ]);
        const fileTree = tree("dist/a.js", "x.log", ".cache/y", "src/index.ts");
        const entries = yield* walkIgnoring({
          rules,
          list: (directory) =>
            Effect.succeed(
              [...fileTree.children.get(directory)!].map(([name, type]) => ({ name, type })),
            ),
        });
        expect(entries.map((entry) => entry.path)).toEqual(["src", "src/index.ts"]);
      }),
    );

    // A project inside an ignored folder (a staging dir, a generated
    // workspace) still lists its own files: only directories below the
    // walk root can exclude their contents.
    it.effect("an ancestor rule excluding the walk root does not hide it", () =>
      Effect.gen(function* () {
        const rules = parseIgnoreRules(".tmp\n*.log\n", "gitignore", {
          prefix: "packages/alchemy/.tmp/fixture-1",
        });
        const fileTree = tree("index.html", "src/main.ts", "debug.log");
        const entries = yield* walkIgnoring({
          rules,
          list: (directory) =>
            Effect.succeed(
              [...fileTree.children.get(directory)!].map(([name, type]) => ({ name, type })),
            ),
        });
        expect(entries.map((entry) => entry.path)).toEqual(["index.html", "src", "src/main.ts"]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Conformance: the same cases on disk, against the tools themselves.
// ---------------------------------------------------------------------------

const materialize = Effect.fn(function* (root: string, entries: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of entries) {
    if (entry.includes(" -> ")) {
      const [link, target] = entry.split(" -> ");
      yield* fs.makeDirectory(path.dirname(path.join(root, link)), { recursive: true });
      yield* fs.symlink(target, path.join(root, link));
    } else if (entry.endsWith("/")) {
      yield* fs.makeDirectory(path.join(root, entry), { recursive: true });
    } else {
      yield* fs.makeDirectory(path.dirname(path.join(root, entry)), { recursive: true });
      yield* fs.writeFileString(path.join(root, entry), entry);
    }
  }
});

const ours = Effect.fn(function* (root: string, ignore: string, dialect: IgnoreDialect) {
  const entries = yield* walkIgnoring({
    list: yield* listFileSystemDirectory(root),
    rules: parseIgnoreRules(ignore, dialect),
  });
  return entries.filter((entry) => entry.type !== "Directory").map((entry) => entry.path);
});

/** All non-directory paths under a root, sorted. */
const listFiles = (root: string) =>
  Effect.gen(function* () {
    const entries = yield* walkIgnoring({ list: yield* listFileSystemDirectory(root) });
    return entries.filter((entry) => entry.type !== "Directory").map((entry) => entry.path);
  });

const run = (command: string, args: string[], cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make(command, args, {
        cwd,
        // Keep the user's global git config and excludes out of the result.
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        extendEnv: true,
      }),
    );
  });

layer(NodeServices.layer)("Ignore rules match the real tools", (it) => {
  for (const testCase of gitignoreCases) {
    it.effect(
      `git: ${testCase.name}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-ignore-git-" });
          yield* materialize(root, testCase.tree);
          yield* fs.writeFileString(path.join(root, ".gitignore"), testCase.ignore);
          yield* run("git", ["init", "-q"], root);
          const git = (yield* run(
            "git",
            ["ls-files", "--others", "--exclude-standard", "-z"],
            root,
          ))
            .split("\0")
            .filter((entry) => entry.length > 0)
            .sort();
          // Git never lists its own `.git` directory.
          const kept = (yield* ours(root, testCase.ignore, "gitignore")).filter(
            (entry) => !entry.startsWith(".git/"),
          );
          expect(kept).toEqual(git);
        }),
      { tags: ["local"] },
    );
  }

  for (const testCase of dockerignoreCases) {
    it.effect(
      `docker: ${testCase.name}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-ignore-docker-" });
          const context = path.join(scratch, "context");
          const out = path.join(scratch, "out");
          yield* materialize(context, testCase.tree);
          yield* fs.writeFileString(path.join(context, ".dockerignore"), testCase.ignore);
          // Outside the context so the Dockerfile itself is not part of it.
          const dockerfile = path.join(scratch, "Containerfile");
          yield* fs.writeFileString(dockerfile, "FROM scratch\nCOPY . /\n");
          yield* run(
            "docker",
            [
              "buildx",
              "build",
              "-q",
              "-f",
              dockerfile,
              "--output",
              `type=local,dest=${out}`,
              context,
            ],
            scratch,
          );
          expect(yield* ours(context, testCase.ignore, "dockerignore")).toEqual(
            yield* listFiles(out),
          );
        }),
      { tags: ["provider:docker", "local"], timeout: 60_000 },
    );
  }
});
