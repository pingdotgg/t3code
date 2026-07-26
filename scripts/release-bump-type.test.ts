import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const scriptPath = NodeURL.fileURLToPath(
  new URL("../apps/mac/scripts/release-bump-type.sh", import.meta.url),
);

const bumpType = (labels: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(scriptPath, [labels], { stdout: "pipe", stderr: "pipe" }),
    );
    const stdout = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    const exitCode = Number(yield* child.exitCode);
    assert.strictEqual(exitCode, 0);
    return stdout.trim();
  });

it.layer(NodeServices.layer)("release-bump-type", (it) => {
  const expectBump = (labels: string, expected: string) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* bumpType(labels), expected);
    });

  it.effect("defaults to patch for a bare release label", () => expectBump("release", "patch"));

  it.effect("defaults to patch with no labels at all", () => expectBump("", "patch"));

  it.effect("ignores unrelated labels", () => expectBump("release size:L bug", "patch"));

  it.effect("uses the patch qualifier when present", () =>
    expectBump("release release:patch", "patch"),
  );

  it.effect("uses the minor qualifier when present", () =>
    expectBump("release release:minor", "minor"),
  );

  it.effect("uses the major qualifier when present", () =>
    expectBump("release release:major", "major"),
  );

  it.effect("treats a qualifier alone as sufficient and honors it", () =>
    expectBump("release:minor", "minor"),
  );

  it.effect("major wins when several qualifiers are present", () =>
    Effect.gen(function* () {
      yield* expectBump("release release:patch release:major", "major");
      yield* expectBump("release:minor release:major", "major");
    }),
  );

  it.effect("minor wins over patch", () => expectBump("release:patch release:minor", "minor"));

  it.effect("does not match qualifiers as substrings of other labels", () =>
    expectBump("release:majors release:minored", "patch"),
  );
});
