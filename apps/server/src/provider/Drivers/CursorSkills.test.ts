import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills, renderCursorSkillInvocations } from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  relativeDirectory: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(skillsDir, relativeDirectory);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
});

const skill = (name: string, description = `Use ${name}.`) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n");

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers every documented direct user and project root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");
      const rootNames = [".agents", ".cursor", ".claude", ".codex"] as const;

      for (const rootName of rootNames) {
        yield* writeSkill(
          path.join(home, rootName, "skills"),
          `user-${rootName.slice(1)}`,
          skill(`user-${rootName.slice(1)}`),
        );
        yield* writeSkill(
          path.join(workspace, rootName, "skills"),
          `project-${rootName.slice(1)}`,
          skill(`project-${rootName.slice(1)}`),
        );
      }

      const skills = yield* discoverCursorSkills(workspace, { HOME: home });

      assert.deepEqual(
        skills.map((entry) => [entry.name, entry.scope]),
        [
          ["project-agents", "project"],
          ["project-claude", "project"],
          ["project-codex", "project"],
          ["project-cursor", "project"],
          ["user-agents", "user"],
          ["user-claude", "user"],
          ["user-codex", "user"],
          ["user-cursor", "user"],
        ],
      );
    }),
  );

  it.effect("discovers nested skills and rejects invalid entries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const workspace = path.join(tempDir, "workspace");
      const skillsDirectory = path.join(workspace, ".cursor", "skills");

      yield* writeSkill(skillsDirectory, "shipping/deploy", skill("deploy"));
      yield* writeSkill(skillsDirectory, "wrong-folder", skill("another-name"));
      yield* writeSkill(skillsDirectory, "no-description", ["---", "name: no-description", "---"].join("\n"));

      const skills = yield* discoverCursorSkills(workspace, { HOME: path.join(tempDir, "home") });

      assert.deepEqual(skills.map((entry) => entry.name), ["deploy"]);
      assert.equal(skills[0]?.path, path.join(skillsDirectory, "shipping", "deploy", "SKILL.md"));
    }),
  );
});

it("renders only known `$skill` tokens as Cursor skill invocations", () => {
  assert.equal(
    renderCursorSkillInvocations("$deploy then $unknown and $review", new Set(["deploy", "review"])),
    "/deploy then $unknown and /review",
  );
});
