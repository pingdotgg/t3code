import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["win32", "darwin", "linux"] as const)(
  "keeps the %s production profile apart from T3 Code's profiles",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-learn-profile-" });
      const state = '{"os_crypt":{"encrypted_key":"t3-code-key"}}';
      const t3CodeProfiles = ["T3 Code (Alpha)", "t3code", "t3code-v2"];
      yield* Effect.forEach(t3CodeProfiles, (name) =>
        fs
          .makeDirectory(path.join(directory, name), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(path.join(directory, name, "Local State"), state)),
          ),
      );

      const userDataPath = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform,
      });

      assert.equal(userDataPath, path.join(directory, "ominax"));
      assert.isFalse(yield* fs.exists(userDataPath));
      assert.deepEqual((yield* fs.readDirectory(directory)).toSorted(), t3CodeProfiles);
      for (const name of t3CodeProfiles) {
        assert.equal(yield* fs.readFileString(path.join(directory, name, "Local State")), state);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
