import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { buildServerProvider } from "./providerSnapshot.ts";
import { augmentProviderSnapshotWithAgentSkills } from "./augmentProviderSnapshotWithAgentSkills.ts";

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

const emptyDraft = () =>
  buildServerProvider({
    presentation: { displayName: "Cursor" },
    enabled: true,
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unauthenticated" },
    },
  });

it.layer(NodeServices.layer)("augmentProviderSnapshotWithAgentSkills", (it) => {
  it.effect("returns the input draft unchanged when no agent skills are found", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-augment-skills-" });
      const agentsHome = path.join(tempDir, "agents-home");
      const workspace = path.join(tempDir, "workspace");

      const draft = emptyDraft();
      const result = yield* augmentProviderSnapshotWithAgentSkills(draft, workspace, {
        homeDirectory: agentsHome,
      });

      // Same reference: the no-op branch must not allocate a new draft, so
      // downstream change-detection sees no update.
      assert.strictEqual(result, draft);
      assert.deepEqual(result.skills, []);
    }),
  );

  it.effect("attaches discovered skills with project winning on collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-augment-skills-" });
      const agentsHome = path.join(tempDir, "agents-home");
      const workspace = path.join(tempDir, "workspace");

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

      const draft = emptyDraft();
      const result = yield* augmentProviderSnapshotWithAgentSkills(draft, workspace, {
        homeDirectory: agentsHome,
      });

      assert.notStrictEqual(result, draft);
      assert.equal(result.skills.length, 1);
      assert.equal(result.skills[0]?.scope, "project");
      assert.equal(result.skills[0]?.description, "Project agents skill.");
      assert.equal(
        result.skills[0]?.path,
        path.join(workspace, ".agents", "skills", "shared-skill", "SKILL.md"),
      );
    }),
  );
});
