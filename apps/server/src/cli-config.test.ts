import os from "node:os";

import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Path } from "effect";

import { NetService } from "@t3tools/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveServerConfig } from "./cli";

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const stateDir = join(os.tmpdir(), "t3-cli-config-env-state");
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          stateDir: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_LOG_LEVEL: "Warn",
                  T3CODE_MODE: "desktop",
                  T3CODE_PORT: "4001",
                  T3CODE_HOST: "0.0.0.0",
                  T3CODE_STATE_DIR: stateDir,
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTH_TOKEN: "env-token",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        keybindingsConfigPath: join(stateDir, "keybindings.json"),
        host: "0.0.0.0",
        stateDir,
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "env-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const stateDir = join(os.tmpdir(), "t3-cli-config-flags-state");
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          stateDir: Option.some(stateDir),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          authToken: Option.some("flag-token"),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_LOG_LEVEL: "Warn",
                  T3CODE_MODE: "desktop",
                  T3CODE_PORT: "4001",
                  T3CODE_HOST: "0.0.0.0",
                  T3CODE_STATE_DIR: join(os.tmpdir(), "ignored-state"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTH_TOKEN: "ignored-token",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  T3CODE_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        keybindingsConfigPath: join(stateDir, "keybindings.json"),
        host: "127.0.0.1",
        stateDir,
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        authToken: "flag-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
      });
    }),
  );
});
