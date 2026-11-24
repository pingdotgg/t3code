// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import { deriveServerPaths } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { resolveServerConfig } from "./config.ts";

const deriveExplicitServerPaths = (baseDir: string, devUrl: URL | undefined) =>
  deriveServerPaths(baseDir, devUrl, { baseDirIsExplicit: true });

const minimalDesktopFlags = (baseDir: string) => ({
  mode: Option.some("desktop" as const),
  port: Option.some(4888),
  host: Option.none<string>(),
  baseDir: Option.some(baseDir),
  cwd: Option.none<string>(),
  devUrl: Option.none<URL>(),
  noBrowser: Option.none<boolean>(),
  bootstrapFd: Option.none<number>(),
  autoBootstrapProjectFromCwd: Option.none<boolean>(),
  logWebSocketEvents: Option.none<boolean>(),
  tailscaleServeEnabled: Option.none<boolean>(),
  tailscaleServePort: Option.none<number>(),
  lan: Option.none<boolean>(),
});

const minimalWebFlags = (baseDir: string) => ({
  ...minimalDesktopFlags(baseDir),
  mode: Option.some("web" as const),
  port: Option.some(3773),
});

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeDesktopBootstrap = (
  overrides: Partial<DesktopBackendBootstrapValue> = {},
): DesktopBackendBootstrapValue => ({
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  t3Home: "/tmp/t3-bootstrap-home",
  host: "127.0.0.1",
  desktopBootstrapToken: "desktop-bootstrap-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  ...overrides,
});

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const defaultObservabilityConfig = {
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: { ...OtelEnvironment.none, disabled: true },
    devAllowedOrigins: [],
  } as const;

  const openBootstrapFd = Effect.fn(function* (payload: DesktopBackendBootstrapValue) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    const encoded = yield* encodeDesktopBootstrap(payload);
    yield* fs.writeFileString(filePath, `${encoded}\n`);
    return yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(filePath, "r")),
      // Windows cannot reopen the fd through /proc or /dev/fd, so the reader closes it.
      (fd) =>
        Effect.sync(() => {
          try {
            NodeFS.closeSync(fd);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
          }
        }),
    );
  });

  it.effect("keeps stale records and supervised startup out of the manual launch preflight", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      for (const [name, pid, mode, rejectRunningServer] of [
        ["stale", 2_147_483_647, "web", true],
        ["own-pid", process.pid, "web", true],
        ["desktop", child.pid, "desktop", true],
        ["serve", child.pid, "web", false],
      ] as const) {
        const baseDir = path.join(root, name);
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const cwd = path.join(root, `${name}-project`);
        const configResult = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some(mode),
            port: Option.some(8788),
            cwd: Option.some(cwd),
          },
          Option.none(),
          { rejectRunningServer },
        ).pipe(
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
          Effect.result,
        );
        assert(Result.isSuccess(configResult));
        expect(configResult.success.cwd).toBe(cwd);
        expect(yield* fs.exists(cwd)).toBe(true);
      }
    }),
  );

  const acquireOwnership = (baseDir: string) =>
    acquireServerOwnership(NodePath.join(baseDir, "userdata", "server-runtime.json")).pipe(
      Effect.provide(Layer.merge(ProcessRunner.layer, NodeCrypto.layer)),
      Effect.provideService(HostProcess.HomeDirectory, baseDir),
      Effect.provideService(HostProcess.Environment, {}),
    );

  const resolveManualWebLaunch = (baseDir: string, cwd: string) =>
    resolveServerConfig({ ...minimalWebFlags(baseDir), cwd: Option.some(cwd) }, Option.none(), {
      rejectRunningServer: true,
    }).pipe(
      Effect.provide(
        Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
      Effect.mapError(String),
      Effect.result,
    );

  it.effect("refuses a manual web launch while a lock-aware server owns the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-live-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const owner = yield* acquireOwnership(baseDir);
      yield* owner.publish({
        version: 1,
        pid: child.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-10-01T00:00:00.000Z",
      });
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain("A T3 Code server is already running");
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect("refuses a manual web launch when a pre-lock record belongs to a live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-legacy-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        yield* encodeUnknownJson({
          version: 1,
          pid: child.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect(
    "allows a manual web launch when a lock-aware record's PID was reused by an unrelated process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-reused-" });
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        // The killed server's lock file stays behind, released.
        yield* Effect.scoped(acquireOwnership(baseDir));
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid: child.pid,
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const cwd = path.join(baseDir, "project");
        const result = yield* resolveManualWebLaunch(baseDir, cwd);
        expect(result).toEqual(Result.succeed(expect.objectContaining({ cwd })));
      }),
  );

  it.effect("names the pair command for the refused server's home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      for (const source of ["flag", "T3CODE_HOME", "default"] as const) {
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-pair-" });
        const baseDir = source === "default" ? path.join(home, ".t3") : home;
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid: child.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const error = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            baseDir: source === "flag" ? Option.some(baseDir) : Option.none(),
            cwd: Option.some(path.join(home, "project")),
          },
          Option.none(),
          { rejectRunningServer: true },
        ).pipe(
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: source === "T3CODE_HOME" ? { T3CODE_HOME: baseDir } : {},
                }),
              ),
            ),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );
        // A temp dir with spaces or backslashes is single-quoted for the shell.
        const homePattern = baseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(String(error)).toMatch(
          new RegExp(`pair --base-dir (${homePattern}|'${homePattern}')`),
        );
      }
    }),
  );

  it.effect("enables a trimmed reusable auth token only for web dev mode", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-dev-auth-" })),
      );
      const flags = {
        mode: Option.some("web" as const),
        port: Option.some(8788),
        host: Option.none<string>(),
        baseDir: Option.some(baseDir),
        cwd: Option.none<string>(),
        devUrl: Option.some(new URL("http://127.0.0.1:5173")),
        noBrowser: Option.none<boolean>(),
        bootstrapFd: Option.none<number>(),
        autoBootstrapProjectFromCwd: Option.none<boolean>(),
        logWebSocketEvents: Option.none<boolean>(),
        tailscaleServeEnabled: Option.none<boolean>(),
        tailscaleServePort: Option.none<number>(),
        lan: Option.none<boolean>(),
      };
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_DEV_AUTH_TOKEN: "  reusable-dev-auth-token-that-is-long-enough  ",
          },
        }),
      );
      const web = yield* resolveServerConfig(flags, Option.none()).pipe(
        Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)),
      );
      const desktop = yield* resolveServerConfig(
        { ...flags, mode: Option.some("desktop" as const) },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));

      expect(web.devAuthToken).toBeDefined();
      if (web.devAuthToken === undefined) {
        return yield* Effect.die("Expected reusable dev auth token.");
      }
      expect(Redacted.value(web.devAuthToken)).toBe("reusable-dev-auth-token-that-is-long-enough");
      expect(desktop.devAuthToken).toBeUndefined();
    }),
  );

  it.effect("does not expose an invalid reusable auth token", () =>
    Effect.gen(function* () {
      const secret = "short-secret";
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-dev-auth-invalid-" })),
      );
      const flags = {
        mode: Option.some("web" as const),
        port: Option.some(8788),
        host: Option.none<string>(),
        baseDir: Option.some(baseDir),
        cwd: Option.none<string>(),
        devUrl: Option.some(new URL("http://127.0.0.1:5173")),
        noBrowser: Option.none<boolean>(),
        bootstrapFd: Option.none<number>(),
        autoBootstrapProjectFromCwd: Option.none<boolean>(),
        logWebSocketEvents: Option.none<boolean>(),
        tailscaleServeEnabled: Option.none<boolean>(),
        tailscaleServePort: Option.none<number>(),
        lan: Option.none<boolean>(),
      };
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_DEV_AUTH_TOKEN: secret } }),
      );
      const error = yield* resolveServerConfig(flags, Option.none()).pipe(
        Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)),
        Effect.flip,
      );
      const desktop = yield* resolveServerConfig(
        { ...flags, mode: Option.some("desktop" as const) },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));
      const staticWeb = yield* resolveServerConfig(
        { ...flags, devUrl: Option.none() },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));

      expect(String(error)).not.toContain(secret);
      const serialized = yield* encodeUnknownJson(error);
      expect(serialized).not.toContain(secret);
      expect(desktop.devAuthToken).toBeUndefined();
      expect(staticWeb.devAuthToken).toBeUndefined();
    }),
  );

  it.effect("preserves explicit false CLI boolean flags over env and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-false-flags");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          noBrowser: true,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveExplicitServerPaths(
        baseDir,
        new URL("http://127.0.0.1:4173"),
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: false,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-wins");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: "/tmp/t3-bootstrap-home",
          noBrowser: false,
          desktopBootstrapToken: "desktop-token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveExplicitServerPaths(
        baseDir,
        new URL("http://127.0.0.1:4173"),
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_MODE: "web",
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_HOME: baseDir,
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("ignores export endpoints even when the SDK is enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-otel-off-" });
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            otlpLogsUrl: "http://localhost:4318/v1/logs",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(minimalDesktopFlags(baseDir), Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  OTEL_SDK_DISABLED: "false",
                  T3CODE_OTLP_METRICS_URL: "https://collector.example.test/v1/metrics",
                  OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBeUndefined();
      expect(resolved.otlpMetricsUrl).toBeUndefined();
      expect(resolved.otlpLogsUrl).toBeUndefined();
      expect(resolved.otelEnvironment.disabled).toBe(true);
    }),
  );

  it.effect("forces noBrowser and disables auto-bootstrap for headless startup presentation", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-headless-base");
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
        },
        Option.none(),
        {
          startupPresentation: "headless",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 3773,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: undefined,
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("uses the automatic port selector only when no port is configured", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-auto-port-" })),
      );
      const selected: Array<readonly [number, string | undefined]> = [];
      const selectAutomaticPort = (preferred: number, host: string | undefined) =>
        Effect.sync(() => {
          selected.push([preferred, host]);
          return 50_123;
        });
      const resolvePort = (flags: {
        readonly mode?: Option.Option<"web" | "desktop">;
        readonly port: Option.Option<number>;
        readonly host?: Option.Option<string>;
      }) =>
        resolveServerConfig({ ...minimalWebFlags(baseDir), ...flags }, Option.none(), {
          selectAutomaticPort,
        }).pipe(
          Effect.map((config) => config.port),
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
        );

      expect(yield* resolvePort({ port: Option.none() })).toBe(50_123);
      expect(yield* resolvePort({ port: Option.none(), host: Option.some("100.64.0.7") })).toBe(
        50_123,
      );
      expect(selected).toEqual([
        [3773, undefined],
        [3773, "100.64.0.7"],
      ]);
      expect(yield* resolvePort({ port: Option.some(8788) })).toBe(8788);
      expect(
        yield* resolvePort({ mode: Option.some("desktop" as const), port: Option.none() }),
      ).toBe(3773);
      expect(selected).toHaveLength(2);
    }),
  );

  it.effect("listens on private networks per T3CODE_LAN, else under the service launcher", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-service-host");
      const resolveHost = (input: {
        readonly connected: boolean;
        readonly env?: Record<string, string>;
      }) =>
        resolveServerConfig(minimalWebFlags(baseDir), Option.none()).pipe(
          Effect.map(({ host, privateNetworkOnly }) => ({ host, privateNetworkOnly })),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
              NetService.layer,
            ),
          ),
          Effect.provideService(HostProcess.Environment, {
            [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              childVersion: packageJson.version,
            }),
          }),
          Effect.provideService(ServiceLauncherHostProcess, {
            connected: input.connected,
            send: () => false,
            on: () => undefined,
            off: () => undefined,
          }),
        );

      // A service installed before T3CODE_LAN existed.
      expect(yield* resolveHost({ connected: true })).toEqual({
        host: "0.0.0.0",
        privateNetworkOnly: true,
      });
      // `service.env` reaches the server as its environment.
      expect(yield* resolveHost({ connected: true, env: { T3CODE_HOST: "127.0.0.1" } })).toEqual({
        host: "127.0.0.1",
        privateNetworkOnly: undefined,
      });
      expect(yield* resolveHost({ connected: true, env: { T3CODE_LAN: "false" } })).toEqual({
        host: undefined,
        privateNetworkOnly: undefined,
      });
      expect(yield* resolveHost({ connected: false, env: { T3CODE_LAN: "true" } })).toEqual({
        host: "0.0.0.0",
        privateNetworkOnly: true,
      });
      // Without the launcher's IPC channel the context was inherited, e.g. by
      // `t3 serve` started from an agent inside the service.
      expect(yield* resolveHost({ connected: false })).toEqual({
        host: undefined,
        privateNetworkOnly: undefined,
      });
    }),
  );
});
