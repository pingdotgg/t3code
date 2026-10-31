import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([
  { isDevelopment: false, sourceName: "t3code", legacyName: "T3 Code (Alpha)" },
  { isDevelopment: false, sourceName: "T3 Code (Alpha)", legacyName: "T3 Code (Alpha)" },
  { isDevelopment: true, sourceName: "t3code-dev", legacyName: "T3 Code (Dev)" },
  { isDevelopment: true, sourceName: "T3 Code (Dev)", legacyName: "T3 Code (Dev)" },
])(
  "preserves Windows credential keys from $sourceName without copying browser databases",
  ({ isDevelopment, sourceName, legacyName }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const stateDir = path.join(directory, "home", "userdata");
      const source = path.join(directory, sourceName);
      const destination = isDevelopment
        ? path.join(stateDir, "electron")
        : path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      const resolve = resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform: "win32",
        stateDir,
      });
      yield* fs.makeDirectory(path.join(directory, legacyName), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      assert.equal(yield* resolve, destination);
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolve;
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
