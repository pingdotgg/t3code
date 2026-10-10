import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { hashSkillFolder, moveRecord, readSources } from "./SkillLockFiles.ts";

/**
 * A skill folder and the hashes the real tools give it: `computedHash` is what the skills CLI's
 * own `computeSkillFolderHash` (vercel-labs/skills v1.7.0, src/local-lock.ts) returned for this
 * folder, and the tree SHA is what `git write-tree` gives. "SKILL.md" sorts before
 * "references/x.md" by bytes and after it by locale, so the sort order matters to the hash.
 */
const GOLDEN = {
  computedHash: "a7f77818fb1962dfbb40da69550e2c9c0c035e97a11012946465db99bad816c0",
  treeSha: "18071366eef226103eef569e462d6a3e8e11fac7",
};

const SKILL_FILE =
  "---\nname: db-migrations\ndescription: Plan and run database migrations.\n---\n\n# Migrations\n";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner.run({
      command: "git",
      args: [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        // The mode is part of a tree, and git only reads it where the filesystem keeps it.
        "-c",
        "core.fileMode=true",
        ...args,
      ],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

/** A temp home with a skill folder written the way the golden hashes were taken. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-locks-" }));
  const write = (relative: string, contents: string, mode?: number) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
      if (mode !== undefined) yield* fs.chmod(target, mode);
    });
  const skill = "repos/acme-web/.agents/skills/db-migrations";
  yield* write(`${skill}/SKILL.md`, SKILL_FILE);
  yield* write(`${skill}/references/x.md`, "Read this first.\n");
  yield* write(`${skill}/scripts/run.sh`, "#!/bin/sh\necho migrate\n", 0o755);
  const project = path.join(home, "repos/acme-web");
  return { fs, path, home, project, write, skill: path.join(home, skill) };
});

const environment = (home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  ...extra,
});

const projectEntry = {
  source: "acme/skills",
  sourceType: "github",
  skillPath: "skills/db-migrations/SKILL.md",
  computedHash: "0".repeat(64),
};

const globalEntry = {
  source: "acme/skills",
  sourceType: "github",
  sourceUrl: "https://github.com/acme/skills.git",
  skillPath: "skills/db-migrations/SKILL.md",
  skillFolderHash: GOLDEN.treeSha,
  installedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/** The project lock as the CLI writes it: skills sorted by name, two-space indent, final newline. */
const projectLockText = (skills: Record<string, unknown>) =>
  `${JSON.stringify({ version: 1, skills }, null, 2)}\n`;

/** The global lock as the CLI writes it: no final newline. */
const globalLockText = (skills: Record<string, unknown>, indent: number | string = 2) =>
  JSON.stringify({ version: 3, skills, dismissed: { findSkillsPrompt: true } }, null, indent);

const it_ = it.layer(NodeServices.layer, { excludeTestServices: true });

it_("SkillLockFiles", (it) => {
  describe("readSources", () => {
    it.effect("reads owner/repo from a v1 project lock and a v3 global lock", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write(
          "repos/acme-web/skills-lock.json",
          projectLockText({
            "db-migrations": projectEntry,
            "from-npm": { source: "left-pad", sourceType: "node_modules", computedHash: "x" },
            "from-disk": { source: "./skills/local", sourceType: "local", computedHash: "x" },
          }),
        );
        yield* write(
          ".agents/.skill-lock.json",
          globalLockText({
            "global-one": { ...globalEntry, source: "acme/other" },
            "odd-source": { ...globalEntry, source: "not a repo" },
          }),
        );

        const sources = yield* readSources({
          environment: environment(home),
          home,
          projectRoot: project,
        });

        expect([...sources.project]).toEqual([["db-migrations", "acme/skills"]]);
        expect([...sources.global]).toEqual([["global-one", "acme/other"]]);
      }),
    );

    it.effect("follows XDG_STATE_HOME for the global lock, as the CLI does", () =>
      Effect.gen(function* () {
        const { home, write } = yield* makeMachine;
        yield* write(".agents/.skill-lock.json", globalLockText({ "in-home": globalEntry }));
        yield* write(
          "state/skills/.skill-lock.json",
          globalLockText({ "in-state": { ...globalEntry, source: "acme/state" } }),
        );

        const sources = yield* readSources({
          environment: environment(home, { XDG_STATE_HOME: `${home}/state` }),
          home,
        });

        expect([...sources.global]).toEqual([["in-state", "acme/state"]]);
      }),
    );

    it.effect("reads nothing from a lock that doesn't parse, or has no skills", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/acme-web/skills-lock.json", '<<<<<<< HEAD\n{"version":1}\n>>>>>>>\n');
        yield* write(".agents/.skill-lock.json", '{"version":3}');

        const sources = yield* readSources({
          environment: environment(home),
          home,
          projectRoot: project,
        });

        expect(sources.project.size).toBe(0);
        expect(sources.global.size).toBe(0);
      }),
    );
  });

  describe("hashSkillFolder", () => {
    it.effect("gives the hashes the skills CLI and git give the same folder", () =>
      Effect.gen(function* () {
        const { fs, path, skill } = yield* makeMachine;
        expect(yield* hashSkillFolder(skill)).toEqual(GOLDEN);

        // The CLI leaves node_modules out of its hash; git's tree would hold it.
        yield* fs.makeDirectory(path.join(skill, "node_modules"));
        yield* fs.writeFileString(path.join(skill, "node_modules/ignored.js"), "ignored\n");
        const withModules = yield* hashSkillFolder(skill);
        expect(withModules?.computedHash).toBe(GOLDEN.computedHash);
        expect(withModules?.treeSha).not.toBe(GOLDEN.treeSha);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "matches git's tree SHA for a folder with a link and an empty folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, skill } = yield* makeMachine;
          yield* fs.symlink("SKILL.md", path.join(skill, "alias.md"));
          yield* fs.makeDirectory(path.join(skill, "empty"));
          yield* git(skill, ["init", "-q", "."]);
          yield* git(skill, ["add", "-A"]);
          const expected = (yield* git(skill, ["write-tree"])).stdout.trim();
          yield* fs.remove(path.join(skill, ".git"), { recursive: true });

          expect((yield* hashSkillFolder(skill))?.treeSha).toBe(expected);
        }),
    );
  });

  describe("moveRecord", () => {
    const lockPaths = (home: string) => ({
      project: `${home}/repos/acme-web/skills-lock.json`,
      global: `${home}/.agents/.skill-lock.json`,
    });

    it.effect("moves a project's record to the global lock as one that is never overwritten", () =>
      Effect.gen(function* () {
        const { fs, home, project, skill, write } = yield* makeMachine;
        const paths = lockPaths(home);
        yield* write(
          "repos/acme-web/skills-lock.json",
          projectLockText({
            aaa: { ...projectEntry, source: "acme/first" },
            "db-migrations": { ...projectEntry, ref: "v2" },
          }),
        );
        // Four-space indent, no final newline: kept as the file had it.
        yield* write(".agents/.skill-lock.json", globalLockText({ existing: globalEntry }, 4));

        const result = yield* moveRecord({
          name: "db-migrations",
          from: { kind: "project", root: project },
          to: { kind: "global" },
          folder: skill,
          environment: environment(home),
          home,
        });

        expect(result).toBe("moved");
        const global = yield* fs.readFileString(paths.global);
        expect(global.endsWith("}")).toBe(true);
        expect(global.startsWith('{\n    "version": 3')).toBe(true);
        const parsed = JSON.parse(global);
        expect(Object.keys(parsed.skills)).toEqual(["existing", "db-migrations"]);
        expect(parsed.skills["db-migrations"]).toEqual({
          source: "acme/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/skills.git",
          ref: "v2",
          skillPath: "skills/db-migrations/SKILL.md",
          skillFolderHash: "",
          installedAt: expect.any(String),
          updatedAt: expect.any(String),
        });
        expect(parsed.skills.existing).toEqual(globalEntry);
        expect(parsed.dismissed).toEqual({ findSkillsPrompt: true });
        // The project lock lost only that entry and kept its form.
        expect(yield* fs.readFileString(paths.project)).toBe(
          projectLockText({ aaa: { ...projectEntry, source: "acme/first" } }),
        );
      }),
    );

    it.effect("creates the global lock in the CLI's empty shape when there is none", () =>
      Effect.gen(function* () {
        const { fs, home, project, skill, write } = yield* makeMachine;
        yield* write(
          "repos/acme-web/skills-lock.json",
          projectLockText({ "db-migrations": projectEntry }),
        );

        yield* moveRecord({
          name: "db-migrations",
          from: { kind: "project", root: project },
          to: { kind: "global" },
          folder: skill,
          environment: environment(home, { XDG_STATE_HOME: `${home}/state` }),
          home,
        });

        const created = JSON.parse(
          yield* fs.readFileString(`${home}/state/skills/.skill-lock.json`),
        );
        expect(Object.keys(created)).toEqual(["version", "skills", "dismissed"]);
        expect(created.version).toBe(3);
        expect(created.skills["db-migrations"].skillFolderHash).toBe("");
        expect(yield* fs.readFileString(lockPaths(home).project)).toBe(projectLockText({}));
      }),
    );

    it.effect(
      "moves a global record to a project when the folder is exactly the recorded tree",
      () =>
        Effect.gen(function* () {
          const { fs, home, project, skill, write } = yield* makeMachine;
          const paths = lockPaths(home);
          yield* write(
            ".agents/.skill-lock.json",
            globalLockText({ "db-migrations": globalEntry, other: globalEntry }),
          );
          yield* write("repos/acme-web/skills-lock.json", projectLockText({ zzz: projectEntry }));

          const result = yield* moveRecord({
            name: "db-migrations",
            from: { kind: "global" },
            to: { kind: "project", root: project },
            folder: skill,
            environment: environment(home),
            home,
          });

          expect(result).toBe("moved");
          // Sorted as the CLI writes a project lock, the default source URL left out.
          expect(yield* fs.readFileString(paths.project)).toBe(
            projectLockText({
              "db-migrations": {
                source: "acme/skills",
                sourceType: "github",
                skillPath: "skills/db-migrations/SKILL.md",
                computedHash: GOLDEN.computedHash,
              },
              zzz: projectEntry,
            }),
          );
          const global = JSON.parse(yield* fs.readFileString(paths.global));
          expect(Object.keys(global.skills)).toEqual(["other"]);
        }),
    );

    it.effect("drops a global record whose folder isn't exactly what was recorded", () =>
      Effect.gen(function* () {
        const { fs, home, project, skill, write } = yield* makeMachine;
        const paths = lockPaths(home);
        yield* write(".agents/.skill-lock.json", globalLockText({ "db-migrations": globalEntry }));
        yield* write("repos/acme-web/skills-lock.json", projectLockText({}));
        // An edit: the CLI couldn't tell what hash upstream's folder has.
        yield* fs.writeFileString(`${skill}/references/x.md`, "Edited.\n");

        const result = yield* moveRecord({
          name: "db-migrations",
          from: { kind: "global" },
          to: { kind: "project", root: project },
          folder: skill,
          environment: environment(home),
          home,
        });

        expect(result).toBe("dropped");
        expect(JSON.parse(yield* fs.readFileString(paths.global)).skills).toEqual({});
        expect(yield* fs.readFileString(paths.project)).toBe(projectLockText({}));
      }),
    );

    it.effect(
      "drops a record that was never version-tracked, or that has no meaning elsewhere",
      () =>
        Effect.gen(function* () {
          const { fs, home, project, skill, write } = yield* makeMachine;
          yield* write(
            ".agents/.skill-lock.json",
            globalLockText({ "db-migrations": { ...globalEntry, skillFolderHash: "" } }),
          );
          const untracked = yield* moveRecord({
            name: "db-migrations",
            from: { kind: "global" },
            to: { kind: "project", root: project },
            folder: skill,
            environment: environment(home),
            home,
          });

          yield* write(
            "repos/acme-web/skills-lock.json",
            projectLockText({
              "db-migrations": { source: "./skills", sourceType: "local", computedHash: "x" },
            }),
          );
          const local = yield* moveRecord({
            name: "db-migrations",
            from: { kind: "project", root: project },
            to: { kind: "global" },
            folder: skill,
            environment: environment(home),
            home,
          });

          expect([untracked, local]).toEqual(["dropped", "dropped"]);
          expect(JSON.parse(yield* fs.readFileString(lockPaths(home).global)).skills).toEqual({});
        }),
    );

    it.effect("never writes a lock it can't parse or whose version it doesn't know", () =>
      Effect.gen(function* () {
        const { fs, home, project, skill, write } = yield* makeMachine;
        const paths = lockPaths(home);
        const sourceText = projectLockText({ "db-migrations": projectEntry });
        yield* write("repos/acme-web/skills-lock.json", sourceText);

        for (const bad of [
          '<<<<<<< HEAD\n{"version":3,"skills":{}}\n=======\n{}\n>>>>>>> main\n',
          JSON.stringify({ version: 2, skills: {} }),
          JSON.stringify({ version: 4, skills: {} }),
          JSON.stringify({ version: 3 }),
        ]) {
          yield* write(".agents/.skill-lock.json", bad);

          const result = yield* moveRecord({
            name: "db-migrations",
            from: { kind: "project", root: project },
            to: { kind: "global" },
            folder: skill,
            environment: environment(home),
            home,
          });

          expect(result).toBe("untouched");
          // Neither lock changed, so the record is still somewhere.
          expect(yield* fs.readFileString(paths.global)).toBe(bad);
          expect(yield* fs.readFileString(paths.project)).toBe(sourceText);
        }

        // The same for a source lock that is a newer version than this writes.
        const newer = JSON.stringify({ version: 2, skills: { "db-migrations": projectEntry } });
        yield* write("repos/acme-web/skills-lock.json", newer);
        yield* write(".agents/.skill-lock.json", globalLockText({}));
        const result = yield* moveRecord({
          name: "db-migrations",
          from: { kind: "project", root: project },
          to: { kind: "global" },
          folder: skill,
          environment: environment(home),
          home,
        });
        expect(result).toBe("untouched");
        expect(yield* fs.readFileString(paths.project)).toBe(newer);
      }),
    );

    it.effect("says there is nothing to move when the skill has no record", () =>
      Effect.gen(function* () {
        const { home, project, skill, write } = yield* makeMachine;
        yield* write("repos/acme-web/skills-lock.json", projectLockText({ other: projectEntry }));

        const result = yield* moveRecord({
          name: "db-migrations",
          from: { kind: "project", root: project },
          to: { kind: "global" },
          folder: skill,
          environment: environment(home),
          home,
        });

        expect(result).toBe("none");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rewrites the file behind a link, as with a lock kept in dotfiles",
      () =>
        Effect.gen(function* () {
          const { fs, home, project, skill, write } = yield* makeMachine;
          yield* write("dotfiles/skill-lock.json", globalLockText({}));
          yield* fs.makeDirectory(`${home}/.agents`, { recursive: true });
          yield* fs.symlink(`${home}/dotfiles/skill-lock.json`, `${home}/.agents/.skill-lock.json`);
          yield* write(
            "repos/acme-web/skills-lock.json",
            projectLockText({ "db-migrations": projectEntry }),
          );

          yield* moveRecord({
            name: "db-migrations",
            from: { kind: "project", root: project },
            to: { kind: "global" },
            folder: skill,
            environment: environment(home),
            home,
          });

          expect(yield* fs.readLink(`${home}/.agents/.skill-lock.json`)).toBe(
            `${home}/dotfiles/skill-lock.json`,
          );
          expect(
            Object.keys(
              JSON.parse(yield* fs.readFileString(`${home}/dotfiles/skill-lock.json`)).skills,
            ),
          ).toEqual(["db-migrations"]);
        }),
    );
  });
});
