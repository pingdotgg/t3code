import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerSettingsError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledDesktopMcp } from "./resolveEnabledDesktopMcp.ts";

describe("resolveEnabledDesktopMcp", () => {
  it.effect("omits the MCP when Computer Use is disabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-enabled-",
      });
      const binaryPath = `${baseDir}/t3-desktop-mcp`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const resolved = yield* resolveEnabledDesktopMcp().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_DESKTOP_MCP_PATH: binaryPath,
        }),
        Effect.provide(ServerSettings.layerTest({ desktopControl: { enabled: false } })),
      );

      assert.equal(resolved, undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes env when agent cursor or browser control is off", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-enabled-",
      });
      const binaryPath = `${baseDir}/t3-desktop-mcp`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const resolved = yield* resolveEnabledDesktopMcp().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_DESKTOP_MCP_PATH: binaryPath,
        }),
        Effect.provide(
          ServerSettings.layerTest({
            desktopControl: {
              enabled: true,
              agentCursorEnabled: false,
              browserControlEnabled: false,
            },
          }),
        ),
      );

      assert.isDefined(resolved);
      assert.equal(resolved?.path, binaryPath);
      assert.deepEqual(resolved?.env, [
        { name: "T3_DESKTOP_AGENT_CURSOR", value: "0" },
        { name: "T3_DESKTOP_BROWSER", value: "0" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("omits the MCP when settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-mcp-enabled-",
      });
      const binaryPath = `${baseDir}/t3-desktop-mcp`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const settingsError = new ServerSettingsError({
        settingsPath: `${baseDir}/settings.json`,
        operation: "read-file",
        cause: "boom",
      });
      const failingService = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      const resolved = yield* resolveEnabledDesktopMcp().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_DESKTOP_MCP_PATH: binaryPath,
        }),
        Effect.provideService(ServerSettings.ServerSettingsService, failingService as never),
      );

      assert.equal(resolved, undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
