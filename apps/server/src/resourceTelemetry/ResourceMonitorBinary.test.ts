import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

// The override checks POSIX exec bits on a real file under a linux platform
// mock; NTFS never reports those bits, so the check cannot be satisfied there.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

describe("ResourceMonitorBinary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("skips Linux libc detection on Windows", () =>
    Effect.gen(function* () {
      const getReport = vi.spyOn(process.report, "getReport").mockImplementation(() => {
        throw new Error("Linux libc detection must not run on Windows");
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor.exe`;
      yield* fileSystem.writeFileString(binaryPath, "binary");

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
      expect(getReport).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("resolves an executable override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("resolves an executable override on an unsupported platform", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/custom-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "freebsd"),
        Effect.provideService(HostProcess.Architecture, "ia32"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a non-executable POSIX override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o644);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unsupported platform and architecture pairs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "freebsd"),
        Effect.provideService(HostProcess.Architecture, "ia32"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects bundled glibc binaries on musl Linux hosts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
