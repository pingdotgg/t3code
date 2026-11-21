import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverSparrowSkills, discoverSparrowSlashCommands } from "./skills.ts";

describe("Sparrow skills & prompts discovery", () => {
  it.effect("discovers project and user skills without duplicates and reads prompts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "sparrow-skills-test-" });
      const home = path.join(root, "home");
      const repo = path.join(root, "repo");
      const sub = path.join(repo, "apps", "demo");

      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(sub, { recursive: true });
      yield* fs.makeDirectory(path.join(sub, ".sparrow", "skills", "local-skill"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(repo, ".agents", "skills", "shared-skill"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, ".config", "sparrow", "skills", "local-skill"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, ".config", "sparrow", "skills", "user-skill"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, ".config", "sparrow", "prompts"), {
        recursive: true,
      });

      yield* fs.writeFileString(
        path.join(sub, ".sparrow", "skills", "local-skill", "SKILL.md"),
        "---\nname: local-skill\ndescription: Project copy\n---\nBody",
      );
      yield* fs.writeFileString(
        path.join(repo, ".agents", "skills", "shared-skill", "SKILL.md"),
        "---\ndescription: Repo agents skill\n---\nBody",
      );
      yield* fs.writeFileString(
        path.join(home, ".config", "sparrow", "skills", "local-skill", "SKILL.md"),
        "---\nname: local-skill\ndescription: Shadowed user copy\n---\n",
      );
      yield* fs.writeFileString(
        path.join(home, ".config", "sparrow", "skills", "user-skill", "SKILL.md"),
        "---\nname: user-skill\ndescription: Global user skill\n---\n",
      );
      yield* fs.writeFileString(
        path.join(home, ".config", "sparrow", "prompts", "review.md"),
        "---\ndescription: Review staged changes\n---\nPlease review",
      );

      const skills = yield* discoverSparrowSkills({
        cwd: sub,
        environment: { HOME: home },
      });
      assert.deepEqual(
        skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          description: skill.description,
        })),
        [
          { name: "local-skill", scope: "project", description: "Project copy" },
          { name: "shared-skill", scope: "project", description: "Repo agents skill" },
          { name: "user-skill", scope: "user", description: "Global user skill" },
        ],
      );

      const commands = yield* discoverSparrowSlashCommands({
        cwd: sub,
        environment: { HOME: home },
      });
      assert.deepEqual(commands, [
        COMPACT_SLASH_COMMAND,
        { name: "review", description: "Review staged changes" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
