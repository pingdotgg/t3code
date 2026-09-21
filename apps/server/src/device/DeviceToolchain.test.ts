import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
it.effect(
  "a Duo archive installs separately from the released hub and verifies its source revision before publishing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-duo-install-" });
      const archive = path.join(baseDir, "prototype.tgz");
      const previous = process.env.T3CODE_DEVICE_HUB_ARCHIVE;
      process.env.T3CODE_DEVICE_HUB_ARCHIVE = archive;
      const { DEVICE_HUB_DUO_VERSION, DEVICE_HUB_DUO_COMMIT, DEVICE_HUB_DUO_PATCH } =
        yield* Effect.promise(() => import("./DeviceToolchain.ts"));
      const installs: string[][] = [];
      let commit = "wrong-revision";
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (request) =>
        Effect.gen(function* () {
          const args = [...(request.args ?? [])];
          installs.push(args);
          const staging = args[args.indexOf("--prefix") + 1]!;
          const pkg = path.join(staging, "node_modules", "expo-device-hub");
          yield* fs.makeDirectory(path.join(pkg, "dist", "server"), { recursive: true });
          yield* fs.writeFileString(path.join(pkg, "dist", "server", "cli.mjs"), "// entry");
          yield* fs.writeFileString(
            path.join(pkg, "package.json"),
            yield* encodeManifest({
              version: DEVICE_HUB_DUO_VERSION,
              t3DeviceHubBuild: {
                serveSimCommit: commit,
                physicalOrientationPatchSha256: DEVICE_HUB_DUO_PATCH,
              },
            }),
          );
          return {
            code: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }).pipe(Effect.orDie);
      yield* Effect.gen(function* () {
        const failed = yield* ensureDeviceHub(baseDir).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, { run }),
          Effect.flip,
        );
        expect(failed.step).toBe("verifying the pinned Duo build");
        expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
        commit = DEVICE_HUB_DUO_COMMIT;
        const installed = yield* ensureDeviceHub(baseDir).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        );
        expect(installed.installDir).toContain(DEVICE_HUB_DUO_VERSION);
        expect(yield* isDeviceHubInstalled(baseDir)).toBe(true);
        expect(installs.every((args) => args.at(-1) === archive)).toBe(true);
        yield* ensureDeviceHub(baseDir).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        );
        expect(installs).toHaveLength(2);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.T3CODE_DEVICE_HUB_ARCHIVE;
            else process.env.T3CODE_DEVICE_HUB_ARCHIVE = previous;
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
