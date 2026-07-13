import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { deriveServerPaths } from "../config.ts";
import { type CliServerFlags, resolveServerConfig } from "./config.ts";

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const emptyFlags = (): CliServerFlags => ({
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
});

const configLayer = (env: Record<string, string> = {}) =>
  Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer);

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const openBootstrapFd = Effect.fn(function* (payload: DesktopBackendBootstrapValue) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    const encoded = yield* encodeDesktopBootstrap(payload);
    yield* fs.writeFileString(filePath, `${encoded}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return fd;
  });

  it.effect("uses environment configuration when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "sergecode-cli-config-env");
      const derivedPaths = yield* deriveServerPaths(baseDir);
      const resolved = yield* resolveServerConfig(emptyFlags(), Option.none()).pipe(
        Effect.provide(
          configLayer({
            T3CODE_LOG_LEVEL: "Warn",
            T3CODE_MODE: "desktop",
            T3CODE_PORT: "4001",
            T3CODE_HOST: "0.0.0.0",
            T3CODE_HOME: baseDir,
            T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
            T3CODE_LOG_WS_EVENTS: "true",
          }),
        ),
      );

      expect(resolved).toMatchObject({
        logLevel: "Warn",
        mode: "desktop",
        port: 4001,
        host: "0.0.0.0",
        baseDir,
        ...derivedPaths,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("gives explicit CLI flags precedence over environment values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "sergecode-cli-config-flags");
      const resolved = yield* resolveServerConfig(
        {
          ...emptyFlags(),
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.some(true),
          tailscaleServePort: Option.some(8443),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          configLayer({
            T3CODE_LOG_LEVEL: "Warn",
            T3CODE_MODE: "desktop",
            T3CODE_PORT: "4001",
            T3CODE_HOST: "0.0.0.0",
            T3CODE_HOME: join(NodeOS.tmpdir(), "ignored-base"),
            T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
            T3CODE_LOG_WS_EVENTS: "true",
          }),
        ),
      );

      expect(resolved).toMatchObject({
        logLevel: "Debug",
        mode: "web",
        port: 8788,
        host: "127.0.0.1",
        baseDir,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
      });
    }),
  );

  it.effect("uses the native bootstrap envelope as a fallback", () =>
    Effect.gen(function* () {
      const baseDir = "/tmp/sergecode-bootstrap-home";
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        t3Home: baseDir,
        host: "127.0.0.2",
        desktopBootstrapToken: "desktop-token",
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
      const resolved = yield* resolveServerConfig(emptyFlags(), Option.none()).pipe(
        Effect.provide(configLayer({ T3CODE_BOOTSTRAP_FD: String(fd) })),
      );

      expect(resolved).toMatchObject({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        baseDir,
        desktopBootstrapToken: "desktop-token",
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
      expect(resolved.stateDir).toBe(`${baseDir}/userdata`);
    }),
  );

  it.effect("creates the native backend's runtime directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "sergecode-cli-config-" });
      const customCwd = path.join(baseDir, "nested", "project");
      const resolved = yield* resolveServerConfig(
        {
          ...emptyFlags(),
          mode: Option.some("desktop"),
          port: Option.some(4888),
          baseDir: Option.some(baseDir),
          cwd: Option.some(customCwd),
        },
        Option.none(),
      ).pipe(Effect.provide(configLayer()));

      for (const directory of [
        customCwd,
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
      expect(resolved.cwd).toBe(path.resolve(customCwd));
    }),
  );
});
