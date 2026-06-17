import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ServerConfig } from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

describe("ResourceMonitorBinary", () => {
  it.effect("resolves an executable override", () =>
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
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(HostProcessEnvironment, {
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
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(HostProcessEnvironment, {
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
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessArchitecture, "ia32"),
        Effect.provideService(HostProcessEnvironment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
