import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const modeOf = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.stat(filePath)).mode & 0o777;
  });

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "keeps the permission bits of the file it replaces",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(yield* fs.makeTempDirectoryScoped(), "settings.json");
        yield* fs.writeFileString(filePath, "{}");
        yield* fs.chmod(filePath, 0o600);

        yield* writeFileStringAtomically({ filePath, contents: '{"a":1}' });

        assert.strictEqual(yield* fs.readFileString(filePath), '{"a":1}');
        assert.strictEqual(yield* modeOf(filePath), 0o600);
      }),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "creates new files readable only by the owner",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(yield* fs.makeTempDirectoryScoped(), "nested", "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: "{}" });

        assert.strictEqual(yield* modeOf(filePath), 0o600);
      }),
  );
});
