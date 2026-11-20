import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { loadRepoEnv } from "./lib/public-config.ts";
import {
  androidSdk,
  buildRunTitle,
  main,
  NativeClientError,
  prebuildAndroid,
  remoteBuildState,
} from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

it.layer(NodeServices.layer)("isolated development identity", (it) => {
  it.effect.each([
    { source: "process", key: "T3CODE_IOS_BUNDLE_ID" },
    { source: "process", key: "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID" },
    { source: ".env", key: "T3CODE_IOS_BUNDLE_ID" },
    { source: ".env", key: "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID" },
    { source: ".env.local", key: "T3CODE_IOS_BUNDLE_ID" },
    { source: ".env.local", key: "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID" },
  ])("ensures the canonical app with $key configured in $source", ({ source, key }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "native-client-identity-" });
      const canonicalId = "com.t3tools.t3code.dev";
      const productionId = "com.example.production";
      const environment = {
        HOME: repo,
        ...(source === "process" ? { [key]: productionId } : {}),
      };
      if (source !== "process") {
        yield* fs.writeFileString(path.join(repo, source), `${key}=${productionId}\n`);
      }
      assert.strictEqual(loadRepoEnv({ baseEnv: environment, repoRoot: repo })[key], productionId);
      const bundle = path.join(repo, "Development.app");
      yield* fs.makeDirectory(bundle);
      yield* fs.writeFileString(path.join(bundle, "binary"), "development client");
      const generatedIos = yield* path.fromFileUrl(new URL("../apps/mobile/ios", import.meta.url));
      const identities: Array<{ step: string; bundleId: string | undefined }> = [];
      let builtId: string | undefined;
      let installedId: string | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          assert.strictEqual(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return assert.fail("Unexpected pipeline");
          const args = command.args;
          let output = "";
          if (args.includes("--eval") || args.includes("prebuild")) {
            // Expo config loads the repo env files again in each subprocess.
            const baseEnv = Object.fromEntries(
              Object.entries(command.options.env ?? {}).map(([name, value]) => [
                name,
                Redacted.isRedacted(value) ? Redacted.value(value) : value,
              ]),
            );
            const config = loadRepoEnv({ baseEnv, repoRoot: repo });
            const bundleId =
              config.T3CODE_IOS_BUNDLE_ID ?? config.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID;
            assert.strictEqual(config.APP_VARIANT, "development");
            assert.strictEqual(config.MOBILE_VERSION_POLICY, "appVersion");
            assert.strictEqual(config.T3CODE_IOS_PERSONAL_TEAM, "0");
            identities.push({
              step: args.includes("--eval") ? "fingerprint" : "prebuild",
              bundleId,
            });
            if (args.includes("--eval")) {
              output = `T3_NATIVE_FINGERPRINT=${(bundleId === canonicalId ? "a" : "b").repeat(64)}`;
            } else {
              builtId = bundleId;
            }
          } else if (args.includes("list") && args.includes("devices")) {
            output = JSON.stringify({
              devices: { iOS: [{ udid: "simulator", name: "iPhone", state: "Booted" }] },
            });
          } else if (args.includes("install") && args.includes("simctl")) {
            installedId = builtId;
          } else if (args.includes("listapps")) {
            output = installedId ? `"${installedId}"` : "";
          } else if (args.includes("get_app_container")) {
            assert.strictEqual(args[3], installedId);
            output = bundle;
          } else {
            assert.include(["git", "bash", "pod", "xcrun", "ditto"], command.command);
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(output)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      yield* Command.runWith(main, { version: "0.0.0" })(["ensure", "ios", "simulator"]).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (directory, options) =>
            directory === generatedIos
              ? Effect.succeed(["Development.xcworkspace"])
              : fs.readDirectory(directory, options),
        }),
        Effect.provide([FetchHttpClient.layer, NodeCrypto.layer]),
      );

      assert.strictEqual(installedId, canonicalId);
      assert.deepStrictEqual(
        new Set(identities.map(({ step }) => step)),
        new Set(["fingerprint", "prebuild"]),
      );
      assert.deepStrictEqual(
        new Set(identities.map(({ bundleId }) => bundleId)),
        new Set([canonicalId]),
      );
      const records = path.join(repo, ".cache/t3code/native-clients/ios");
      const [record] = yield* fs.readDirectory(records);
      assert.isDefined(record);
      assert.strictEqual(
        JSON.parse(yield* fs.readFileString(path.join(records, record!))).fingerprint,
        "a".repeat(64),
      );
      assert.strictEqual(loadRepoEnv({ baseEnv: environment, repoRoot: repo })[key], productionId);
    }),
  );
});

it.layer(NodeServices.layer)("androidSdk", (it) => {
  it.effect("skips a configured SDK path that holds no SDK", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "android-sdk-home-" });
      const sdk = path.join(home, "sdk");
      yield* fs.makeDirectory(path.join(sdk, "platform-tools"), { recursive: true });

      const resolved = yield* androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          ANDROID_HOME: path.join(home, "stale"),
          ANDROID_SDK_ROOT: sdk,
        }),
      );

      assert.strictEqual(resolved, sdk);
    }),
  );
});

it("finds a Blacksmith build by its run title and reads its state", () => {
  const fingerprint = "a".repeat(40);
  const title = buildRunTitle("android", "x86_64", fingerprint);
  assert.strictEqual(title, `Dev client android x86_64 ${fingerprint}`);
  assert.strictEqual(buildRunTitle("ios", null, fingerprint), `Dev client ios ${fingerprint}`);
  const run = (
    createdAt: string,
    status: string,
    conclusion: string | null,
    displayTitle = title,
  ) => ({
    displayTitle,
    status,
    conclusion,
    createdAt,
  });
  const since = Date.parse("2026-11-09T12:00:00Z");
  assert.strictEqual(remoteBuildState([], title, since), "none");
  // Another client's run, and a run from before this wait, say nothing about this build.
  assert.strictEqual(
    remoteBuildState(
      [
        run(
          "2026-11-09T12:05:00Z",
          "in_progress",
          null,
          buildRunTitle("android", "arm64-v8a", fingerprint),
        ),
        run("2026-11-09T11:00:00Z", "completed", "failure"),
      ],
      title,
      since,
    ),
    "none",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "queued", null)], title, since),
    "running",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "completed", "success")], title, since),
    "succeeded",
  );
  // The newest run decides: a retry that is running outranks the failure before it.
  assert.strictEqual(
    remoteBuildState(
      [
        run("2026-11-09T12:01:00Z", "completed", "failure"),
        run("2026-11-09T12:09:00Z", "in_progress", null),
      ],
      title,
      since,
    ),
    "running",
  );
  assert.strictEqual(
    remoteBuildState([run("2026-11-09T12:01:00Z", "completed", "cancelled")], title, since),
    "failed",
  );
});
