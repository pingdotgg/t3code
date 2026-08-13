import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import { makeWorkspaceSkillsCache } from "./workspaceSkills.ts";

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

const skillDocument = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---"].join("\n");

/** Mirrors how `ClaudeDriver` wires discovery: config per instance, cwd per call. */
const makeClaudeWorkspaceSkills = Effect.fn(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* makeWorkspaceSkillsCache((cwd) =>
    discoverClaudeSkills({ homePath: configDir }, cwd, {}).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    ),
  );
});

it.layer(NodeServices.layer)("workspace-scoped skills", (it) => {
  it.effect("answers each workspace with its own project skills plus the user skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const alpha = path.join(tempDir, "alpha");
      const beta = path.join(tempDir, "beta");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "global-review",
        skillDocument("global-review", "Available everywhere."),
      );
      yield* writeSkill(
        path.join(alpha, ".claude", "skills"),
        "alpha-deploy",
        skillDocument("alpha-deploy", "Deploy alpha."),
      );
      yield* writeSkill(
        path.join(beta, ".claude", "skills"),
        "beta-deploy",
        skillDocument("beta-deploy", "Deploy beta."),
      );

      const listWorkspaceSkills = yield* makeClaudeWorkspaceSkills(configDir);

      const alphaSkills = yield* listWorkspaceSkills(alpha);
      const betaSkills = yield* listWorkspaceSkills(beta);
      assert.deepStrictEqual(
        alphaSkills?.map((skill) => `${skill.scope}:${skill.name}`),
        ["project:alpha-deploy", "user:global-review"],
      );
      assert.deepStrictEqual(
        betaSkills?.map((skill) => `${skill.scope}:${skill.name}`),
        ["project:beta-deploy", "user:global-review"],
      );
    }),
  );

  it.effect("lets the workspace's project skill win a name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        skillDocument("deploy", "User deploy."),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        skillDocument("deploy", "Project deploy."),
      );

      const listWorkspaceSkills = yield* makeClaudeWorkspaceSkills(configDir);
      const skills = yield* listWorkspaceSkills(workspace);

      assert.strictEqual(skills?.length, 1);
      assert.strictEqual(skills?.[0]?.scope, "project");
      assert.strictEqual(skills?.[0]?.description, "Project deploy.");
    }),
  );

  it.effect("degrades to user skills when the workspace directory is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "global-review",
        skillDocument("global-review", "Available everywhere."),
      );

      const listWorkspaceSkills = yield* makeClaudeWorkspaceSkills(configDir);
      const skills = yield* listWorkspaceSkills(path.join(tempDir, "does-not-exist"));

      assert.deepStrictEqual(
        skills?.map((skill) => skill.name),
        ["global-review"],
      );
    }),
  );

  it.effect("caches per workspace so reopening the picker does not rescan", () =>
    Effect.gen(function* () {
      const lookups = yield* Ref.make<ReadonlyArray<string>>([]);
      const listWorkspaceSkills = yield* makeWorkspaceSkillsCache((cwd) =>
        Ref.update(lookups, (previous) => [...previous, cwd]).pipe(Effect.as([])),
      );

      yield* listWorkspaceSkills("/repos/alpha");
      yield* listWorkspaceSkills("/repos/alpha");
      yield* listWorkspaceSkills("/repos/beta");

      // An empty answer is still an answer, so it stays cached.
      assert.deepStrictEqual(yield* Ref.get(lookups), ["/repos/alpha", "/repos/beta"]);
    }),
  );

  it.effect("retries after a failed lookup instead of caching the unknown", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const listWorkspaceSkills = yield* makeWorkspaceSkillsCache(() =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.map((count) =>
            count === 1
              ? undefined
              : [{ name: "deploy", path: "/repos/alpha/.codex/skills/deploy", enabled: true }],
          ),
        ),
      );

      assert.strictEqual(yield* listWorkspaceSkills("/repos/alpha"), undefined);
      assert.deepStrictEqual(
        (yield* listWorkspaceSkills("/repos/alpha"))?.map((skill) => skill.name),
        ["deploy"],
      );
      assert.strictEqual(yield* Ref.get(attempts), 2);

      yield* listWorkspaceSkills("/repos/alpha");
      assert.strictEqual(yield* Ref.get(attempts), 2);
    }),
  );
});
