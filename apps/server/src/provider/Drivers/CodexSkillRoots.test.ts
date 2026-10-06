import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexSkillRoots } from "./CodexSkillRoots.ts";

describe("codexSkillRoots", () => {
  it.effect("follows the app-server's CODEX_HOME precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skill-roots-" });
      const userHome = path.resolve("/users/someone");
      const homeOf = (homePath: string, environment: NodeJS.ProcessEnv) =>
        codexSkillRoots({ homePath, environment: { HOME: userHome, ...environment }, cwd }).pipe(
          Effect.map((roots) => roots[0]),
        );

      assert.strictEqual(
        yield* homeOf("/configured/codex", { CODEX_HOME: "/environment/codex" }),
        path.join(path.resolve("/configured/codex"), "skills"),
      );
      assert.strictEqual(
        yield* homeOf("", { CODEX_HOME: "/environment/codex" }),
        path.join(path.resolve("/environment/codex"), "skills"),
      );
      assert.strictEqual(yield* homeOf("", {}), path.join(userHome, ".codex", "skills"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists project roots from the cwd up to the repository root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-codex-skill-roots-repo-",
      });
      const cwd = path.join(repository, "packages", "app");
      yield* fileSystem.makeDirectory(path.join(repository, ".git"));
      yield* fileSystem.makeDirectory(cwd, { recursive: true });

      const roots = yield* codexSkillRoots({
        homePath: "",
        environment: { HOME: NodeOS.homedir() },
        cwd,
      });

      assert.deepStrictEqual(roots.slice(1), [
        path.join(NodeOS.homedir(), ".agents", "skills"),
        ...[cwd, path.join(repository, "packages"), repository].flatMap((directory) => [
          path.join(directory, ".agents", "skills"),
          path.join(directory, ".codex", "skills"),
        ]),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
