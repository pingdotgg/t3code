import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

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
    const error = yield* ensureDeviceHub(baseDir, baseDir).pipe(
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

it.effect("audits device tool installs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-audit-base-" });
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-audit-state-" });
    const success = {
      code: ChildProcessSpawner.ExitCode(0),
      stdout: "",
      stderr: "",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const runner = {
      run: ({ args }: ProcessRunner.ProcessRunInput) =>
        fs
          .makeDirectory(
            path.dirname(
              path.join(args[2]!, "node_modules", "expo-device-hub", "dist", "server", "cli.mjs"),
            ),
            { recursive: true },
          )
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                path.join(args[2]!, "node_modules", "expo-device-hub", "dist", "server", "cli.mjs"),
                "",
              ),
            ),
            Effect.orDie,
            Effect.as(success),
          ),
    };
    yield* ensureDeviceHub(baseDir, stateDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    const auditDirectory = path.join(stateDir, "audit");
    const auditFiles = yield* fs.readDirectory(auditDirectory);
    const first = JSON.parse(
      yield* fs.readFileString(path.join(auditDirectory, auditFiles[0]!)),
    ) as { url: string; error?: string };
    expect(first.url).toBe(`npm:expo-device-hub@${DEVICE_HUB_VERSION}`);
    expect(first.error).toBeUndefined();
    yield* ensureDeviceHub(baseDir, stateDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    expect((yield* fs.readDirectory(auditDirectory)).length).toBe(1);

    const failedStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-audit-fail-" });
    const failed = {
      ...success,
      code: ChildProcessSpawner.ExitCode(1),
      stderr: "registry rejected",
    };
    const error = yield* ensureDeviceHub(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-audit-fail-base-" }),
      failedStateDir,
    ).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.succeed(failed) }),
      Effect.flip,
    );
    expect(error._tag).toBe("DeviceToolchainInstallError");
    const failedFiles = yield* fs.readDirectory(path.join(failedStateDir, "audit"));
    const failure = JSON.parse(
      yield* fs.readFileString(path.join(failedStateDir, "audit", failedFiles[0]!)),
    ) as { url: string; error?: string };
    expect(failure.url).toBe(`npm:expo-device-hub@${DEVICE_HUB_VERSION}`);
    expect(failure.error).toContain("exit code 1");
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
