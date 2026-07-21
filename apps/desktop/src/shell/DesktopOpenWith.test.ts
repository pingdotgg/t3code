import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  OpenWithEntry,
  OpenWithEntryId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopOpenWith from "./DesktopOpenWith.ts";

const decodeEntry = Schema.decodeUnknownSync(OpenWithEntry);

const configuredEntries = [
  decodeEntry({
    id: "echo",
    name: "Echo",
    kind: "other",
    invocation: { type: "command", executable: "/bin/echo" },
    directoryMode: "open-target",
    arguments: [],
  }),
  decodeEntry({
    id: "missing",
    name: "Missing",
    kind: "other",
    invocation: { type: "command", executable: "/definitely/missing/t3-open-with" },
    directoryMode: "open-target",
    arguments: [],
  }),
] as const;

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/src",
  homeDirectory: "/tmp",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.0.0",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({ T3CODE_HOME: "/tmp/t3-open-with" }),
    ),
  ),
);

const openWithLayer = DesktopOpenWith.layer.pipe(
  Layer.provideMerge(
    DesktopClientSettings.layerTest(
      Option.some({
        ...DEFAULT_CLIENT_SETTINGS,
        openWithEntries: configuredEntries,
      }),
    ),
  ),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("DesktopOpenWith launch resolution", () => {
  it.effect("appends the directory for open-target command entries", () =>
    Effect.gen(function* () {
      const launch = yield* DesktopOpenWith.resolveOpenWithLaunch(
        decodeEntry({
          id: "echo",
          name: "Echo",
          kind: "other",
          invocation: { type: "command", executable: "/bin/echo" },
          directoryMode: "open-target",
          arguments: ["--flag"],
        }),
        "/tmp/work tree",
        "darwin",
      );
      assert.deepEqual(launch, {
        command: "/bin/echo",
        args: ["--flag", "/tmp/work tree"],
        shell: false,
        cwd: null,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sets cwd without adding a directory argument in working-directory mode", () =>
    Effect.gen(function* () {
      const launch = yield* DesktopOpenWith.resolveOpenWithLaunch(
        decodeEntry({
          id: "echo",
          name: "Echo",
          kind: "other",
          invocation: { type: "command", executable: "/bin/echo" },
          directoryMode: "working-directory",
          arguments: ["one argument"],
        }),
        "/tmp/work tree",
        "darwin",
      );
      assert.deepEqual(launch, {
        command: "/bin/echo",
        args: ["one argument"],
        shell: false,
        cwd: "/tmp/work tree",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("expands placeholders within independent argument rows without shell parsing", () =>
    Effect.gen(function* () {
      const launch = yield* DesktopOpenWith.resolveOpenWithLaunch(
        decodeEntry({
          id: "echo",
          name: "Echo",
          kind: "other",
          invocation: { type: "command", executable: "/bin/echo" },
          directoryMode: "custom-arguments",
          arguments: ["prefix={directory}=suffix", "literal value"],
        }),
        "/tmp/work tree",
        "darwin",
      );
      assert.deepEqual(launch.args, ["prefix=/tmp/work tree=suffix", "literal value"]);
      assert.isFalse(launch.shell ?? false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves CFBundleExecutable and reports missing bundle executables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-open-with-test-" });
      const applicationPath = path.join(base, "Fixture.app");
      const contentsPath = path.join(applicationPath, "Contents");
      const executableDirectory = path.join(contentsPath, "MacOS");
      yield* fileSystem.makeDirectory(executableDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(contentsPath, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>`,
      );
      const executablePath = path.join(executableDirectory, "Fixture");
      yield* fileSystem.writeFileString(executablePath, "#!/bin/sh\n");

      assert.equal(
        yield* DesktopOpenWith.resolveMacBundleExecutable(applicationPath),
        executablePath,
      );
      yield* fileSystem.remove(executablePath);
      const error = yield* Effect.flip(DesktopOpenWith.resolveMacBundleExecutable(applicationPath));
      assert.equal(error.reason, "missing-executable");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports available and missing command presentations", () =>
    Effect.gen(function* () {
      const openWith = yield* DesktopOpenWith.DesktopOpenWith;
      const presentations = yield* openWith.resolvePresentations;
      assert.deepEqual(presentations, [
        { entryId: configuredEntries[0].id, available: true, iconDataUrl: null },
        {
          entryId: configuredEntries[1].id,
          available: false,
          iconDataUrl: null,
          unavailableReason: "Executable not found: /definitely/missing/t3-open-with",
        },
      ]);
    }).pipe(Effect.provide(openWithLayer)),
  );

  it.effect("rejects secondary environments, invalid targets, and unknown entry ids", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-open-target-" });
      const openWith = yield* DesktopOpenWith.DesktopOpenWith;

      const remoteError = yield* Effect.flip(
        openWith.open({
          environmentId: EnvironmentId.make("ssh:test"),
          entryId: configuredEntries[0].id,
          directory,
        }),
      );
      assert.equal(remoteError._tag, "OpenWithEnvironmentError");

      const relativeError = yield* Effect.flip(
        openWith.open({
          environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
          entryId: configuredEntries[0].id,
          directory: "relative/path",
        }),
      );
      assert.equal(relativeError._tag, "OpenWithInvalidTargetError");

      const unknownError = yield* Effect.flip(
        openWith.open({
          environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
          entryId: OpenWithEntryId.make("unknown"),
          directory,
        }),
      );
      assert.equal(unknownError._tag, "OpenWithMissingEntryError");
    }).pipe(Effect.provide(openWithLayer), Effect.scoped),
  );
});
