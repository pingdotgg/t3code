import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  EXCLUDE_BLOCK_END,
  EXCLUDE_BLOCK_START,
  editExcludeBlock,
  excludeNewFile,
  updateExclude,
} from "./SkillGitExclude.ts";

const block = (...lines: string[]) => [EXCLUDE_BLOCK_START, ...lines, EXCLUDE_BLOCK_END].join("\n");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner.run({
      command: "git",
      args: ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(VcsProcess.layer));

const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-exclude-" }));
  const repo = path.join(root, "acme-web");
  yield* fs.makeDirectory(repo, { recursive: true });
  yield* git(repo, ["init", "-q", "-b", "main"]);
  // Not the machine's own global ignore file, which may already name what a test creates.
  yield* git(repo, ["config", "core.excludesFile", path.join(root, "global-ignore")]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "# acme-web\n");
  yield* git(repo, ["add", "-A"]);
  yield* git(repo, ["commit", "-q", "-m", "init"]);
  return { fs, path, root, repo };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillGitExclude", (it) => {
  describe("editExcludeBlock", () => {
    it("starts a block at the end and leaves the user's lines alone", () => {
      expect(editExcludeBlock("*.log\n", { add: ["/.agents/skills/a"], remove: [] })).toBe(
        `*.log\n${block("/.agents/skills/a")}\n`,
      );
      expect(editExcludeBlock("*.log", { add: ["/.agents/skills/a"], remove: [] })).toBe(
        `*.log\n${block("/.agents/skills/a")}\n`,
      );
      expect(editExcludeBlock("", { add: ["/.agents/skills/a"], remove: [] })).toBe(
        `${block("/.agents/skills/a")}\n`,
      );
    });

    it("adds to and removes from the block without repeating a line", () => {
      const start = `# mine\n${block("/a", "/b")}\n# after\n`;

      expect(editExcludeBlock(start, { add: ["/b", "/c"], remove: [] })).toBe(
        `# mine\n${block("/a", "/b", "/c")}\n# after\n`,
      );
      expect(editExcludeBlock(start, { add: [], remove: ["/a"] })).toBe(
        `# mine\n${block("/b")}\n# after\n`,
      );
    });

    it("removes the whole block when its last line goes, and gives back the file it started from", () => {
      const original = "# mine\n*.log\n";
      const withBlock = editExcludeBlock(original, { add: ["/a", "/b"], remove: [] });

      expect(editExcludeBlock(withBlock, { add: [], remove: ["/a", "/b"] })).toBe(original);
      expect(editExcludeBlock(`${block("/a")}\n`, { add: [], remove: ["/a"] })).toBe("");
      expect(editExcludeBlock(original, { add: [], remove: ["/never-there"] })).toBe(original);
    });

    it("leaves an unfinished block as it found it", () => {
      const broken = `*.log\n${EXCLUDE_BLOCK_START}\n/kept\n`;

      expect(editExcludeBlock(broken, { add: ["/a"], remove: [] })).toBe(broken);
      expect(editExcludeBlock(broken, { add: [], remove: ["/kept"] })).toBe(broken);
    });
  });

  describe("updateExclude", () => {
    it.effect("keeps links out of git status, and takes the lines out again", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const link = path.join(repo, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toContain("?? .agents/");

        yield* run(updateExclude({ projectRoot: repo, links: [link], action: "add" }));
        const exclude = path.join(repo, ".git/info/exclude");
        expect(yield* fs.readFileString(exclude)).toContain(
          `${EXCLUDE_BLOCK_START}\n/.agents/skills/db-migrations\n${EXCLUDE_BLOCK_END}\n`,
        );
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toBe("");

        yield* run(updateExclude({ projectRoot: repo, links: [link], action: "remove" }));
        expect(yield* fs.readFileString(exclude)).not.toContain("T3 Code");
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toContain("?? .agents/");
      }),
    );

    it.effect("anchors the lines at the repository when the project is a folder inside it", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const project = path.join(repo, "packages/web");
        const link = path.join(project, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);

        yield* run(updateExclude({ projectRoot: project, links: [link], action: "add" }));

        expect(yield* fs.readFileString(path.join(repo, ".git/info/exclude"))).toContain(
          "\n/packages/web/.agents/skills/db-migrations\n",
        );
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toBe("");
      }),
    );

    it.effect("writes to the common git dir, so every worktree shares the lines", () =>
      Effect.gen(function* () {
        const { fs, path, root, repo } = yield* makeRepo;
        const worktree = path.join(root, "acme-web-feature");
        yield* git(repo, ["worktree", "add", "-q", "-b", "feature", worktree]);
        const link = path.join(worktree, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);

        yield* run(updateExclude({ projectRoot: worktree, links: [link], action: "add" }));

        expect(yield* fs.readFileString(path.join(repo, ".git/info/exclude"))).toContain(
          "\n/.agents/skills/db-migrations\n",
        );
        expect((yield* git(worktree, ["status", "--porcelain"])).stdout).toBe("");
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toBe("");
      }),
    );

    it.effect("quotes a skill name that git would read as a pattern", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const link = path.join(repo, ".agents/skills/[draft]*");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);
        const other = path.join(repo, ".agents/skills/d");
        yield* fs.symlink(path.join(repo, "README.md"), other);

        yield* run(updateExclude({ projectRoot: repo, links: [link], action: "add" }));

        // Only the link named, not the one the unquoted pattern would also match.
        expect((yield* git(repo, ["status", "--porcelain", "-uall"])).stdout).toBe(
          "?? .agents/skills/d\n",
        );
      }),
    );

    it.effect("does nothing for a project that isn't in a git repository", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* makeRepo;
        const loose = path.join(root, "marketing-site");
        const link = path.join(loose, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(root, "acme-web/README.md"), link);

        yield* run(updateExclude({ projectRoot: loose, links: [link], action: "add" }));

        expect(yield* fs.exists(path.join(loose, ".git"))).toBe(false);
        expect(yield* fs.readDirectory(path.join(loose, ".agents"))).toEqual(["skills"]);
      }),
    );

    it.effect("leaves an unfinished block alone, and goes on without failing", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const link = path.join(repo, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);
        const exclude = path.join(repo, ".git/info/exclude");
        const broken = `*.log\n${EXCLUDE_BLOCK_START}\n/kept\n`;
        yield* fs.writeFileString(exclude, broken);

        yield* run(updateExclude({ projectRoot: repo, links: [link], action: "add" }));
        yield* run(updateExclude({ projectRoot: repo, links: [link], action: "remove" }));

        // No second block is added, so a later edit never pairs the dangling start with a new end.
        expect(yield* fs.readFileString(exclude)).toBe(broken);
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toContain("?? .agents/");
      }),
    );

    it.effect("fails, and writes nothing, when the exclude file can't be written", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const link = path.join(repo, ".agents/skills/db-migrations");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(path.join(repo, "README.md"), link);
        // A file where the info folder goes.
        yield* fs.remove(path.join(repo, ".git/info"), { recursive: true });
        yield* fs.writeFileString(path.join(repo, ".git/info"), "not a folder");

        const failure = yield* run(
          updateExclude({ projectRoot: repo, links: [link], action: "add" }),
        ).pipe(Effect.flip);

        expect(failure).toBeDefined();
        expect(yield* fs.readFileString(path.join(repo, ".git/info"))).toBe("not a folder");
      }),
    );
  });

  describe("excludeNewFile", () => {
    const LOCAL_BLOCK =
      "# T3 Code: local settings\n/.claude/settings.local.json\n# End T3 Code: local settings\n";

    it.effect("keeps a file that was just created out of git, in a block of its own", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const file = path.join(repo, ".claude/settings.local.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "{}\n");
        expect((yield* git(repo, ["status", "--porcelain"])).stdout).toBe("?? .claude/\n");

        yield* run(excludeNewFile({ projectRoot: repo, file }));

        expect(yield* fs.readFileString(path.join(repo, ".git/info/exclude"))).toContain(
          LOCAL_BLOCK,
        );
        expect((yield* git(repo, ["status", "--porcelain", "-uall"])).stdout).toBe("");
        // Doing it again changes nothing.
        const before = yield* fs.readFileString(path.join(repo, ".git/info/exclude"));
        yield* run(excludeNewFile({ projectRoot: repo, file }));
        expect(yield* fs.readFileString(path.join(repo, ".git/info/exclude"))).toBe(before);
      }),
    );

    it.effect("leaves a file the repository ignores already, or tracks, alone", () =>
      Effect.gen(function* () {
        const { fs, path, repo } = yield* makeRepo;
        const exclude = path.join(repo, ".git/info/exclude");
        const before = yield* fs.readFileString(exclude);
        const ignored = path.join(repo, ".claude/settings.local.json");
        yield* fs.makeDirectory(path.dirname(ignored), { recursive: true });
        yield* fs.writeFileString(ignored, "{}\n");
        yield* fs.writeFileString(
          path.join(repo, ".gitignore"),
          "**/.claude/settings.local.json\n",
        );

        yield* run(excludeNewFile({ projectRoot: repo, file: ignored }));
        expect(yield* fs.readFileString(exclude)).toBe(before);

        // Tracked, whatever ignores it.
        yield* fs.remove(path.join(repo, ".gitignore"));
        yield* git(repo, ["add", "-f", ".claude/settings.local.json"]);
        yield* git(repo, ["commit", "-q", "-m", "track it"]);
        yield* run(excludeNewFile({ projectRoot: repo, file: ignored }));
        expect(yield* fs.readFileString(exclude)).toBe(before);
      }),
    );

    it.effect("does nothing for a project that isn't in a git repository", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* makeRepo;
        const loose = path.join(root, "marketing-site");
        const file = path.join(loose, ".claude/settings.local.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "{}\n");

        yield* run(excludeNewFile({ projectRoot: loose, file }));

        expect(yield* fs.exists(path.join(loose, ".git"))).toBe(false);
      }),
    );
  });
});
