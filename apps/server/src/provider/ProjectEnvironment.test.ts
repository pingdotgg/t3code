import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveProjectEnvironment } from "./ProjectEnvironment.ts";

describe("resolveProjectEnvironment", () => {
  it.effect("activates Mise without loading the user's shell profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const projectDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-mise-project-",
      });
      const binDirectory = path.join(projectDirectory, "bin");
      yield* fileSystem.makeDirectory(binDirectory);
      yield* fileSystem.writeFileString(path.join(projectDirectory, "mise.toml"), "[tools]\n");

      const misePath = path.join(binDirectory, platform === "win32" ? "mise.cmd" : "mise");
      const activation =
        platform === "win32"
          ? [
              "@echo off",
              'if not "%1"=="activate" exit /b 2',
              'if not "%2"=="pwsh" exit /b 3',
              "echo $env:T3_MISE_TEST = 'active'",
            ].join("\r\n")
          : [
              "#!/bin/sh",
              '[ "$1" = "activate" ] || exit 2',
              '[ "$2" = "sh" ] || exit 3',
              "printf '%s\\n' 'export T3_MISE_TEST=active'",
            ].join("\n");
      yield* fileSystem.writeFileString(misePath, activation);
      if (platform !== "win32") yield* fileSystem.chmod(misePath, 0o755);

      const inheritedEnvironment = {
        ...process.env,
        PATH: `${binDirectory}${platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        T3_INHERITED_TEST: "preserved",
      };
      const environment = yield* resolveProjectEnvironment({
        cwd: projectDirectory,
        environment: inheritedEnvironment,
      });

      expect(environment.T3_MISE_TEST).toBe("active");
      expect(environment.T3_INHERITED_TEST).toBe("preserved");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves projects without Mise configuration unchanged", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-plain-project-",
      });
      const inheritedEnvironment = { PATH: "baseline", T3_INHERITED_TEST: "preserved" };

      expect(
        yield* resolveProjectEnvironment({
          cwd: projectDirectory,
          environment: inheritedEnvironment,
        }),
      ).toBe(inheritedEnvironment);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
