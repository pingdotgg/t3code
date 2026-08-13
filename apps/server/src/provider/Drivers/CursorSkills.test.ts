import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers user and project Cursor skills with frontmatter descriptions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills"),
        "linear-plan-followup",
        [
          "---",
          "name: linear-plan-followup",
          "description: File a Linear follow-up.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills-cursor"),
        "babysit",
        ["---", "name: babysit", "description: Keep a PR merge-ready.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "drizzle-relational-queries",
        [
          "---",
          "name: drizzle-relational-queries",
          "description: Prefer relational queries.",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "better-auth-best-practices",
        ["---", "name: better-auth-best-practices", "description: Better Auth setup.", "---"].join(
          "\n",
        ),
      );

      const skills = yield* discoverCursorSkills({ homeDir, cwd: workspace });

      assert.deepEqual(
        skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          description: skill.description,
        })),
        [
          {
            name: "babysit",
            scope: "user",
            description: "Keep a PR merge-ready.",
          },
          {
            name: "better-auth-best-practices",
            scope: "project",
            description: "Better Auth setup.",
          },
          {
            name: "drizzle-relational-queries",
            scope: "project",
            description: "Prefer relational queries.",
          },
          {
            name: "linear-plan-followup",
            scope: "user",
            description: "File a Linear follow-up.",
          },
        ],
      );
    }),
  );

  it.effect("prefers project .cursor skills over user and .agents on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: User agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: User cursor deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project cursor deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverCursorSkills({ homeDir, cwd: workspace });

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project cursor deploy.");
      assert.equal(skills[0]?.path, path.join(workspace, ".cursor", "skills", "deploy", "SKILL.md"));
    }),
  );

  it.effect("uses the directory name even when frontmatter name differs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills"),
        "add-model-support",
        ["---", "name: something-else", "description: Add a model.", "---"].join("\n"),
      );

      const skills = yield* discoverCursorSkills({ homeDir });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["add-model-support"],
      );
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const skillsDir = path.join(homeDir, ".cursor", "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverCursorSkills({ homeDir });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("scans extra project roots and ignores unusable cwds like /", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const extraProject = path.join(tempDir, "sentrex");

      yield* writeSkill(
        path.join(extraProject, ".cursor", "skills"),
        "update-relevant-docs",
        ["---", "name: update-relevant-docs", "description: Update docs.", "---"].join("\n"),
      );

      const skills = yield* discoverCursorSkills({
        homeDir,
        cwd: "/",
        extraProjectCwds: [extraProject, extraProject, "/"],
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["update-relevant-docs"],
      );
      assert.equal(skills[0]?.scope, "project");
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });

      const skills = yield* discoverCursorSkills({
        homeDir: path.join(tempDir, "missing-home"),
        cwd: path.join(tempDir, "missing-workspace"),
      });

      assert.deepEqual(skills, []);
    }),
  );
});
