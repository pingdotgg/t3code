import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspaceAgentSkills from "./WorkspaceAgentSkills.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceAgentSkills.layer.pipe(Layer.provide(WorkspacePaths.layer));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-agent-skills-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursorAgent");

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  description: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${directoryName}`, `description: ${description}`, "---"].join("\n"),
  );
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceAgentSkills", (it) => {
  it.effect("Claude resolves portable + native project skills, native wins on collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-was-claude-" });

      yield* writeSkill(path.join(cwd, ".agents", "skills"), "portable", "Portable.");
      // Same name in both roots: Claude-native (.claude) must win.
      yield* writeSkill(path.join(cwd, ".agents", "skills"), "deploy", "Portable deploy.");
      yield* writeSkill(path.join(cwd, ".claude", "skills"), "deploy", "Claude deploy.");

      const { skills } = yield* (function* () {
        const workspaceAgentSkills = yield* WorkspaceAgentSkills.WorkspaceAgentSkills;
        return yield* workspaceAgentSkills.list({ cwd, provider: CLAUDE });
      })();
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      expect(new Set(byName.keys())).toEqual(new Set(["portable", "deploy"]));
      expect(byName.get("deploy")?.description).toBe("Claude deploy.");
      expect(byName.get("deploy")?.scope).toBe("project");
    }),
  );

  it.effect("non-Claude providers resolve portable project skills only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-was-cursor-" });

      yield* writeSkill(path.join(cwd, ".agents", "skills"), "portable", "Portable.");
      // A Claude-native project skill must not leak to other providers.
      yield* writeSkill(path.join(cwd, ".claude", "skills"), "claude-only", "Claude only.");

      const { skills } = yield* (function* () {
        const workspaceAgentSkills = yield* WorkspaceAgentSkills.WorkspaceAgentSkills;
        return yield* workspaceAgentSkills.list({ cwd, provider: CURSOR });
      })();

      expect(skills.map((skill) => skill.name)).toEqual(["portable"]);
    }),
  );
});
