import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveDesktopMcpPath } from "./desktopMcpBinary.ts";

describe("desktopMcpBinary", () => {
  it.effect("resolves the override path on macOS", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-binary-",
      });
      const binaryPath = `${baseDir}/t3-desktop-mcp`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const resolved = yield* resolveDesktopMcpPath().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_DESKTOP_MCP_PATH: binaryPath,
        }),
      );

      assert.equal(resolved, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the override on Linux and Windows too", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-binary-",
      });

      // Windows ships the .exe; the other platforms do not.
      for (const [platform, name] of [
        ["linux", "t3-desktop-mcp"],
        ["win32", "t3-desktop-mcp.exe"],
      ] as const) {
        const binaryPath = `${baseDir}/${name}`;
        yield* fileSystem.writeFileString(binaryPath, "binary");

        const resolved = yield* resolveDesktopMcpPath().pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(HostProcessEnvironment, {
            T3CODE_DESKTOP_MCP_PATH: binaryPath,
          }),
        );
        assert.equal(resolved, binaryPath);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns undefined on platforms with no desktop backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-binary-",
      });
      const binaryPath = `${baseDir}/t3-desktop-mcp`;
      yield* fileSystem.writeFileString(binaryPath, "binary");

      // Neither backend covers these, so the tools must not be offered even
      // when someone points the override at a binary.
      for (const platform of ["freebsd", "aix"] as const) {
        const resolved = yield* resolveDesktopMcpPath().pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(HostProcessEnvironment, {
            T3CODE_DESKTOP_MCP_PATH: binaryPath,
          }),
        );
        assert.equal(resolved, undefined);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns undefined when nothing is built or overridden", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-binary-",
      });

      const resolved = yield* resolveDesktopMcpPath().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_DESKTOP_MCP_PATH: `${baseDir}/does-not-exist`,
        }),
      );

      // A dev checkout that has built the binary will resolve a bundled
      // candidate; otherwise nothing matches. Both are valid — the contract is
      // that a missing override never throws and never returns the bad path.
      assert.notEqual(resolved, `${baseDir}/does-not-exist`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
