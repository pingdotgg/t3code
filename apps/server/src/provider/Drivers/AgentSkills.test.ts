import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgentSkills } from "./AgentSkills.ts";

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

const isolatedDiscoveryOptions = (tempDir: string) => ({
  homeDirectory: `${tempDir}/isolated-home`,
});

it.layer(NodeServices.layer)("discoverAgentSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-skills-" });
      const workspace = path.join(tempDir, "workspace");
      const agentsHome = path.join(tempDir, "agents-home");

      yield* writeSkill(
        path.join(agentsHome, ".agents", "skills"),
        "agent-browser",
        ["---", "name: agent-browser", "description: Browser automation.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "test-t3-app",
        ["---", "name: test-t3-app", "description: Test the web app.", "---"].join("\n"),
      );

      const skills = yield* discoverAgentSkills(workspace, { homeDirectory: agentsHome });

      assert.deepEqual(skills, [
        {
          name: "agent-browser",
          path: path.join(agentsHome, ".agents", "skills", "agent-browser", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Browser automation.",
        },
        {
          name: "test-t3-app",
          path: path.join(workspace, ".agents", "skills", "test-t3-app", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Test the web app.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-skills-" });
      const workspace = path.join(tempDir, "workspace");
      const agentsHome = path.join(tempDir, "agents-home");

      yield* writeSkill(
        path.join(agentsHome, ".agents", "skills"),
        "shared-skill",
        ["---", "name: shared-skill", "description: User agents skill.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "shared-skill",
        ["---", "name: shared-skill", "description: Project agents skill.", "---"].join("\n"),
      );

      const skills = yield* discoverAgentSkills(workspace, { homeDirectory: agentsHome });

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project agents skill.");
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-skills-" });
      const agentsHome = path.join(tempDir, "agents-home");
      const skillsDir = path.join(agentsHome, ".agents", "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverAgentSkills(undefined, { homeDirectory: agentsHome });

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
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-skills-" });

      const skills = yield* discoverAgentSkills(
        path.join(tempDir, "missing-workspace"),
        isolatedDiscoveryOptions(tempDir),
      );

      assert.deepEqual(skills, []);
    }),
  );
});
