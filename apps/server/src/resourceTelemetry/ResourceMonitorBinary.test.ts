import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

// The override checks POSIX exec bits on a real file under a linux platform
// mock; NTFS never reports those bits, so the check cannot be satisfied there.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

describe("ResourceMonitorBinary", () => {
  it.effect("uses the injected path service for cross-platform absolute paths", () =>
    Effect.gen(function* () {
      const posixPath = yield* Path.Path.pipe(Effect.provide(NodePath.layerPosix));
      const win32Path = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));

      assert.isTrue(
        ResourceMonitorBinary.isResourceMonitorPathAbsolute("/tmp/monitor", "linux", posixPath),
      );
      assert.isFalse(
        ResourceMonitorBinary.isResourceMonitorPathAbsolute("C:\\tmp\\monitor", "linux", posixPath),
      );
      assert.isTrue(
        ResourceMonitorBinary.isResourceMonitorPathAbsolute(
          "C:\\tmp\\monitor.exe",
          "win32",
          win32Path,
        ),
      );
      assert.isTrue(
        ResourceMonitorBinary.isResourceMonitorPathAbsolute(
          "\\\\server\\share\\monitor.exe",
          "win32",
          win32Path,
        ),
      );
      assert.isFalse(
        ResourceMonitorBinary.isResourceMonitorPathAbsolute("/tmp/monitor", "win32", win32Path),
      );
    }),
  );

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
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, { resourceMonitorPath: binaryPath }),
        ),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessArchitecture, "arm64"),
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
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, { resourceMonitorPath: binaryPath }),
        ),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
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
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, { resourceMonitorPath: binaryPath }),
        ),
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessArchitecture, "ia32"),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("rejects a non-executable POSIX override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o644);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, { resourceMonitorPath: binaryPath }),
        ),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a missing explicit override instead of falling back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath =
        platform === "win32"
          ? `${baseDir}\\missing-resource-monitor.exe`
          : `${baseDir}/missing-resource-monitor`;
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, { resourceMonitorPath: binaryPath }),
        ),
        Effect.provideService(HostProcessArchitecture, "x64"),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotFound);
      assert.deepEqual(error.candidates, [binaryPath]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a relative explicit override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir, {
            resourceMonitorPath: "relative/resource-monitor",
          }),
        ),
        Effect.provideService(HostProcessArchitecture, "x64"),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryInvalidPath);
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
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessArchitecture, "ia32"),
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
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
