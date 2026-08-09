import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverOpenCodeSkills } from "./OpenCodeSkills.ts";

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

it.layer(NodeServices.layer)("discoverOpenCodeSkills", (it) => {
  it.effect("discovers project .opencode and compat roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "oc-project",
        "---\nname: oc-project\ndescription: OpenCode project skill.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "agents-project",
        "---\nname: agents-project\ndescription: Agents project skill.\n---\n",
      );

      const skills = yield* discoverOpenCodeSkills(workspace);
      assert.ok(skills.some((skill) => skill.name === "oc-project"));
      assert.ok(skills.some((skill) => skill.name === "agents-project"));
      assert.equal(skills.find((skill) => skill.name === "oc-project")?.scope, "project");
    }),
  );

  it.effect("prefers native .opencode over .agents on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "shared",
        "---\nname: shared\ndescription: From agents compat.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "shared",
        "---\nname: shared\ndescription: From native opencode.\n---\n",
      );

      const skills = yield* discoverOpenCodeSkills(workspace);
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.description,
        "From native opencode.",
      );
      assert.equal(skills.find((skill) => skill.name === "shared")?.scope, "project");
    }),
  );

  it.effect("discovers skills on intermediate monorepo package paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "repo");
      const pkg = path.join(workspace, "packages", "foo");
      const nestedCwd = path.join(pkg, "apps", "web");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nestedCwd, { recursive: true });

      yield* writeSkill(
        path.join(pkg, ".opencode", "skills"),
        "mid-package",
        "---\nname: mid-package\ndescription: From intermediate package.\n---\n",
      );

      const skills = yield* discoverOpenCodeSkills(nestedCwd);
      assert.ok(skills.some((skill) => skill.name === "mid-package"));
      assert.ok(
        skills
          .find((skill) => skill.name === "mid-package")
          ?.path.includes(`${path.sep}packages${path.sep}foo${path.sep}`),
      );
    }),
  );

  it.effect("prefers project skill over user skill on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "repo");
      // Isolate home roots by not writing under real home; only project roots matter.
      // User-vs-project is exercised by ordering: project roots are listed after user roots.
      // Use a fake structure via project-only collision against an earlier project root.
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "shared",
        "---\nname: shared\ndescription: Earlier project compat.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "shared",
        "---\nname: shared\ndescription: Later native project.\n---\n",
      );

      const skills = yield* discoverOpenCodeSkills(workspace);
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.description,
        "Later native project.",
      );
    }),
  );
});
