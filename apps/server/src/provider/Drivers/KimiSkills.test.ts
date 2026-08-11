import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKimiSkills } from "./KimiSkills.ts";

const writeSkill = Effect.fn(function* (root: string, directory: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(root, directory);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverKimiSkills", (it) => {
  it.effect("sorts skills and lets project definitions replace user definitions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-kimi-skills-",
      });
      const kimiHome = path.join(tempDirectory, "kimi-home");
      const osHome = path.join(tempDirectory, "os-home");
      const workspace = path.join(tempDirectory, "workspace");

      yield* writeSkill(
        path.join(kimiHome, "skills"),
        "review",
        ["---", "name: review", "description: Review from Kimi home.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(osHome, ".agents", "skills"),
        "shared",
        ["---", "name: shared", "description: Shared user skill.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".kimi-code", "skills"),
        "review",
        ["---", "name: review", "description: Project review skill.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "project",
        ["---", "name: project", "description: Project agent skill.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "malformed",
        ["---", "name: [unclosed", "---"].join("\n"),
      );

      const skills = yield* discoverKimiSkills({ homePath: kimiHome }, workspace, { HOME: osHome });

      assert.deepEqual(skills, [
        {
          name: "project",
          description: "Project agent skill.",
          path: path.join(workspace, ".agents", "skills", "project", "SKILL.md"),
          enabled: true,
          scope: "project",
        },
        {
          name: "review",
          description: "Project review skill.",
          path: path.join(workspace, ".kimi-code", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "project",
        },
        {
          name: "shared",
          description: "Shared user skill.",
          path: path.join(osHome, ".agents", "skills", "shared", "SKILL.md"),
          enabled: true,
          scope: "user",
        },
      ]);
    }),
  );

  it.effect("skips missing roots and entries without a readable skill file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-kimi-skills-",
      });
      const kimiHome = path.join(tempDirectory, "kimi-home");
      const workspace = path.join(tempDirectory, "workspace");
      yield* fileSystem.makeDirectory(path.join(kimiHome, "skills", "empty"), { recursive: true });

      const skills = yield* discoverKimiSkills({ homePath: kimiHome }, workspace, {
        HOME: path.join(tempDirectory, "os-home"),
      });

      assert.deepEqual(skills, []);
    }),
  );

  it.effect("does not follow a discovered skill link outside its configured root", () => {
    // Windows can prohibit test symlink creation. This filesystem double models
    // its relevant observable behavior: a listed child resolves outside its root.
    const fileSystem = FileSystem.makeNoop({
      realPath: (value) =>
        Effect.succeed(value.endsWith("SKILL.md") ? "C:\\outside\\SKILL.md" : "C:\\root"),
      readDirectory: () => Effect.succeed(["escaped"]),
      readFileString: () => Effect.die("outside skill content must never be read"),
    });
    return discoverKimiSkills({ homePath: "C:\\kimi-home" }, "C:\\workspace", {
      HOME: "C:\\os-home",
    }).pipe(
      Effect.tap((skills) => Effect.sync(() => assert.deepEqual(skills, []))),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });
});
