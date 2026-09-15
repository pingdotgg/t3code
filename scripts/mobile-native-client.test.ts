import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  NativeClientError,
  clientStatus,
  ensureClient,
  hashBundle,
  installedBinary,
  type NativeClientRecord,
} from "./mobile-native-client.ts";

it("requires a build for absent, unrecorded, replaced, and stale clients", () => {
  const record = { fingerprint: "native-a", binary: "binary-a" };
  assert.equal(clientStatus("native-a", null, record), "missing");
  assert.equal(clientStatus("native-a", "binary-a", null), "unknown");
  assert.equal(clientStatus("native-a", "binary-b", record), "unknown");
  assert.equal(clientStatus("native-b", "binary-a", record), "stale");
  assert.equal(clientStatus("native-a", "binary-a", record), "compatible");
});

it.effect("builds an unknown client once, then reuses it across JavaScript changes", () =>
  Effect.gen(function* () {
    let record: NativeClientRecord | null = null;
    let builds = 0;
    const operations = {
      fingerprint: Effect.succeed("native-a"),
      installedBinary: Effect.succeed("binary-a"),
      readRecord: Effect.sync(() => record),
      build: Effect.sync(() => {
        builds++;
      }),
      saveRecord: (value: NativeClientRecord) =>
        Effect.sync(() => {
          record = value;
        }),
    };
    assert.equal((yield* ensureClient(operations)).rebuilt, true);
    assert.equal((yield* ensureClient(operations)).rebuilt, false);
    assert.equal(builds, 1);
    assert.deepEqual(record, { fingerprint: "native-a", binary: "binary-a" });
  }),
);

it.effect(
  "never records failed builds, missing installations, or native inputs changed during a build",
  () =>
    Effect.gen(function* () {
      for (const failure of ["build", "missing", "changed"] as const) {
        let built = false;
        let recorded = false;
        const result = yield* ensureClient({
          fingerprint: Effect.sync(() =>
            built && failure === "changed" ? "native-b" : "native-a",
          ),
          installedBinary: Effect.succeed(null),
          readRecord: Effect.succeed(null),
          build: Effect.gen(function* () {
            if (failure === "build")
              return yield* new NativeClientError({ message: "Compiler failed" });
            built = true;
          }),
          saveRecord: () =>
            Effect.sync(() => {
              recorded = true;
            }),
        }).pipe(Effect.flip);
        assert.match(result.message, /Compiler failed|not installed|inputs changed/);
        assert.equal(recorded, false);
      }
    }),
);

it.effect(
  "detects native library and resource replacement independent of the install directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-client-test-" });
      const first = path.join(root, "first.app");
      const second = path.join(root, "second.app");
      for (const dir of [first, second]) {
        yield* fs.makeDirectory(path.join(dir, "Frameworks"), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "Frameworks/native.dylib"),
          "native-a".repeat(20000),
        );
        yield* fs.writeFileString(path.join(dir, "Info.plist"), "config-a");
        yield* fs.symlink("Info.plist", path.join(dir, "config-link"));
      }
      const baseline = yield* hashBundle(first);
      assert.equal(yield* hashBundle(second), baseline);
      yield* fs.writeFileString(path.join(second, "Frameworks/native.dylib"), "native-b");
      assert.notEqual(yield* hashBundle(second), baseline);
      yield* fs.writeFileString(
        path.join(second, "Frameworks/native.dylib"),
        "native-a".repeat(20000),
      );
      yield* fs.writeFileString(path.join(second, "Info.plist"), "config-b");
      assert.notEqual(yield* hashBundle(second), baseline);
      yield* fs.writeFileString(path.join(second, "Info.plist"), "config-a");
      assert.equal(yield* hashBundle(second), baseline);
      yield* fs.remove(path.join(second, "config-link"));
      yield* fs.symlink("Frameworks/native.dylib", path.join(second, "config-link"));
      assert.notEqual(yield* hashBundle(second), baseline);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "recognizes Android APK installs with randomized tilde paths and rejects failed hash reads",
  () =>
    Effect.gen(function* () {
      let hashOutput =
        "a".repeat(64) + "  /data/app/~~random==/com.t3tools.t3code.dev-abc==/base.apk";
      const run = (_program: string, args: string[]) => {
        if (args.includes("list")) return Effect.succeed("package:com.t3tools.t3code.dev");
        if (args.includes("path"))
          return Effect.succeed(
            "package:/data/app/~~random==/com.t3tools.t3code.dev-abc==/base.apk",
          );
        return Effect.succeed(hashOutput);
      };
      const binary = yield* installedBinary("android", "emulator-5554", run);
      assert.match(binary!, /^[a-f0-9]{64}$/);
      hashOutput = "sha256sum: read error";
      const error = yield* installedBinary("android", "emulator-5554", run).pipe(Effect.flip);
      assert.match(error.message, /Could not hash/);
      assert.equal(
        yield* installedBinary("android", "emulator-5554", () => Effect.succeed("")),
        null,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
