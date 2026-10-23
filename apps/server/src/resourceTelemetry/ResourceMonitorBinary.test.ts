import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

// The override checks POSIX exec bits on a real file under a linux platform
// mock; NTFS never reports those bits, so the check cannot be satisfied there.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

describe("ResourceMonitorBinary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // regression: #16838 a directory resolved as the resource monitor binary
  it.effect("rejects a directory override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: baseDir,
        }),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, baseDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["release", "debug"])(
    "resolves a cargo %s binary from the built server layout",
    (profile) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-resource-monitor-binary-",
        });
        const projectDirectory = path.join(baseDir, "repo");
        const distDirectory = path.join(projectDirectory, "apps", "server", "dist");
        const binaryDirectory = path.join(
          projectDirectory,
          "native",
          "resource-monitor",
          "target",
          profile,
        );
        const binaryPath = path.join(binaryDirectory, "t3-resource-monitor.exe");
        yield* fileSystem.makeDirectory(distDirectory, { recursive: true });
        yield* fileSystem.makeDirectory(binaryDirectory, { recursive: true });
        yield* fileSystem.writeFileString(binaryPath, "binary");
        yield* fileSystem.chmod(binaryPath, 0o755);

        const service = yield* ResourceMonitorBinary.make().pipe(
          // The bundled module lives in dist rather than src/resourceTelemetry.
          Effect.provideService(Path.Path, {
            ...path,
            resolve: (...segments) =>
              path.resolve(
                ...segments.map((segment) =>
                  segment === import.meta.dirname ? distDirectory : segment,
                ),
              ),
          }),
          Effect.provide(ServerConfig.layerTest(projectDirectory, baseDir)),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Architecture, "arm64"),
          Effect.provideService(HostProcess.Environment, {}),
        );

        assert.equal(yield* service.resolve, binaryPath);
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
