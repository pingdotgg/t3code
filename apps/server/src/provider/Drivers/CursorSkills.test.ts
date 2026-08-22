import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  relativeDir: string,
  description: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, relativeDir);
  const name = path.basename(skillDir);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers native, shared, Claude, and Codex project skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });

      yield* writeSkill(path.join(repo, ".cursor", "skills"), "cursor-skill", "Cursor.");
      yield* writeSkill(path.join(repo, ".agents", "skills"), "agents-skill", "Agents.");
      yield* writeSkill(path.join(repo, ".claude", "skills"), "claude-skill", "Claude.");
      yield* writeSkill(path.join(repo, ".codex", "skills"), "codex-skill", "Codex.");

      const skills = yield* discoverCursorSkills(repo);
      const projectSkills = skills.filter((skill) => skill.scope === "project");
      assert.deepEqual(
        projectSkills.map((skill) => skill.name),
        ["agents-skill", "claude-skill", "codex-skill", "cursor-skill"],
      );
    }),
  );

  it.effect("recursively discovers grouped skills and prefers the nested cwd tier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const nested = path.join(repo, "apps", "web");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(path.join(repo, ".cursor", "skills"), "shipping/deploy", "Root.");
      yield* writeSkill(path.join(nested, ".cursor", "skills"), "workflow/deploy", "Nested.");

      const skills = yield* discoverCursorSkills(nested);
      const deploy = skills.find((skill) => skill.name === "deploy");
      assert.equal(deploy?.description, "Nested.");
      assert.ok(deploy?.path.includes(`${path.sep}apps${path.sep}web${path.sep}`));
    }),
  );
});
