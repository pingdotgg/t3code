import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots } from "./ProviderSkills.ts";

it.layer(NodeServices.layer)("discoverSkillsFromRoots", (it) => {
  it.effect("discovers skill metadata from each root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-skills-" });
      const userRoot = path.join(tempDir, "user-skills");
      const projectRoot = path.join(tempDir, "project-skills");
      const userSkillPath = path.join(userRoot, "review", "SKILL.md");
      const projectSkillPath = path.join(projectRoot, "deploy", "SKILL.md");

      yield* fs.makeDirectory(path.dirname(userSkillPath), { recursive: true });
      yield* fs.writeFileString(
        userSkillPath,
        ["---", "name: review", "description: Review the change.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(path.dirname(projectSkillPath), { recursive: true });
      yield* fs.writeFileString(
        projectSkillPath,
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );

      const skills = yield* discoverSkillsFromRoots([
        { directory: userRoot, scope: "user" },
        { directory: projectRoot, scope: "project" },
      ]);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          description: "Deploy the app.",
          path: projectSkillPath,
          scope: "project",
          enabled: true,
        },
        {
          name: "review",
          description: "Review the change.",
          path: userSkillPath,
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("lets later roots win and skips missing roots and malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-skills-" });
      const userRoot = path.join(tempDir, "user-skills");
      const projectRoot = path.join(tempDir, "project-skills");
      const userSkillPath = path.join(userRoot, "deploy", "SKILL.md");
      const projectSkillPath = path.join(projectRoot, "deploy", "SKILL.md");
      const malformedSkillPath = path.join(projectRoot, "broken", "SKILL.md");
      const unterminatedSkillPath = path.join(projectRoot, "unterminated", "SKILL.md");
      const nonStringFieldsSkillPath = path.join(projectRoot, "fallback-name", "SKILL.md");

      yield* fs.makeDirectory(path.dirname(userSkillPath), { recursive: true });
      yield* fs.writeFileString(
        userSkillPath,
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(path.dirname(projectSkillPath), { recursive: true });
      yield* fs.writeFileString(
        projectSkillPath,
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(path.dirname(malformedSkillPath), { recursive: true });
      yield* fs.writeFileString(malformedSkillPath, "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(path.dirname(unterminatedSkillPath), { recursive: true });
      yield* fs.writeFileString(unterminatedSkillPath, "---\nname: unfinished\n");
      yield* fs.makeDirectory(path.dirname(nonStringFieldsSkillPath), { recursive: true });
      yield* fs.writeFileString(
        nonStringFieldsSkillPath,
        ["---", "name: 2024", "description:", "  nested: value", "---"].join("\n"),
      );

      const skills = yield* discoverSkillsFromRoots([
        { directory: path.join(tempDir, "missing"), scope: "user" },
        { directory: userRoot, scope: "user" },
        { directory: projectRoot, scope: "project" },
      ]);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          description: "Project deploy.",
          path: projectSkillPath,
          scope: "project",
          enabled: true,
        },
        {
          name: "fallback-name",
          path: nonStringFieldsSkillPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );
});
