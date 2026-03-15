import { NetService } from "@t3tools/shared/Net";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { resolveServerConfig, type CliInput } from "./cli";

const emptyInput = (): CliInput => ({
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  stateDir: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  authToken: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
});

describe("cli config resolution", () => {
  it.effect("falls back to environment values when flags are omitted", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveServerConfig(emptyInput()).pipe(
        Effect.provide(NetService.layer),
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              T3CODE_MODE: "desktop",
              T3CODE_PORT: "4123",
              T3CODE_HOST: "127.0.0.1",
              T3CODE_STATE_DIR: "/tmp/t3-state",
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
              T3CODE_NO_BROWSER: "true",
              T3CODE_AUTH_TOKEN: "secret",
              T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
              T3CODE_LOG_WS_EVENTS: "true",
            },
          }),
        ),
      );

      expect(resolved).toEqual({
        mode: "desktop",
        port: 4123,
        host: "127.0.0.1",
        cwd: process.cwd(),
        keybindingsConfigPath: "/tmp/t3-state/keybindings.json",
        stateDir: "/tmp/t3-state",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "secret",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("uses CLI flags as the final override", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveServerConfig({
        ...emptyInput(),
        mode: Option.some("web"),
        port: Option.some(4444),
        host: Option.some("0.0.0.0"),
        stateDir: Option.some("/tmp/t3-override"),
        devUrl: Option.some(new URL("http://127.0.0.1:4173")),
        noBrowser: Option.some("false"),
        authToken: Option.some("override-token"),
        autoBootstrapProjectFromCwd: Option.some("true"),
        logWebSocketEvents: Option.some("false"),
      }).pipe(
        Effect.provide(NetService.layer),
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              T3CODE_MODE: "desktop",
              T3CODE_PORT: "4123",
              T3CODE_HOST: "127.0.0.1",
              T3CODE_STATE_DIR: "/tmp/t3-state",
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
              T3CODE_NO_BROWSER: "true",
              T3CODE_AUTH_TOKEN: "secret",
              T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
              T3CODE_LOG_WS_EVENTS: "true",
            },
          }),
        ),
      );

      expect(resolved).toEqual({
        mode: "web",
        port: 4444,
        host: "0.0.0.0",
        cwd: process.cwd(),
        keybindingsConfigPath: "/tmp/t3-override/keybindings.json",
        stateDir: "/tmp/t3-override",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: false,
        authToken: "override-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: false,
      });
    }),
  );
});
