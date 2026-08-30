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
  it.effect("discovers user skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );

      const skills = yield* discoverCursorSkills({ homeDir });

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(homeDir, ".cursor", "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
      ]);
    }),
  );

  it.effect("discovers project skills from workspace .cursor and .agents directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the changes.", "---"].join("\n"),
      );

      const skills = yield* discoverCursorSkills({ homeDir, cwd: workspace });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".cursor", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
        {
          name: "review",
          path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Review the changes.",
        },
      ]);
    }),
  );

  it.effect("prefers later roots on name collisions across user and project scopes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude home deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".omp", "agent", "skills"),
        "deploy",
        ["---", "name: deploy", "description: OMP deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents home deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Cursor home deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents project deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Cursor project deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverCursorSkills({ homeDir, cwd: workspace });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Claude project deploy.",
        },
      ]);
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
