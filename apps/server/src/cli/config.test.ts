// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { deriveServerPaths } from "../config.ts";
import { resolveServerConfig } from "./config.ts";

const deriveExplicitServerPaths = (baseDir: string, devUrl: URL | undefined) =>
  deriveServerPaths(baseDir, devUrl, { baseDirIsExplicit: true });

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
    otelEnvironment: OtelEnvironment.none,
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

  it.effect(
    "refuses a manual web launch when a runtime record belongs to another live process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-live-" });
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
        const error = yield* resolveServerConfig(
          { ...minimalWebFlags(baseDir), cwd: Option.some(cwd) },
          Option.none(),
          { rejectRunningServer: true },
        ).pipe(
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
          Effect.flip,
        );
        expect(String(error)).toContain("A T3 Code server is already running");
        expect(String(error)).toContain(`pid ${child.pid}`);
        expect(yield* fs.exists(cwd)).toBe(false);
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

  it.effect("zeroes an endpoint stored in Settings when the SDK is disabled", () =>
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

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
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
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OTEL_SDK_DISABLED: "true" } })),
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

  it.effect("lets T3CODE_OTEL_SDK_DISABLED=false override an ambient OTEL_SDK_DISABLED=true", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-otel-on-" });
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
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
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "true" },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otelEnvironment.disabled).toBe(false);
      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
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

  it.effect("keeps whitespace-separated pairs and literal equals signs in OTLP headers", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-otlp-headers-loose-base");

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
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_OTLP_HEADERS: "authorization=Bearer abc==, x-tenant=t3",
                  T3CODE_OTLP_TRACES_URL: "http://collector.internal:4318",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesExport.headers).toEqual({
        authorization: "Bearer abc==",
        "x-tenant": "t3",
      });
      expect(resolved.otlpTracesUrl).toBe("http://collector.internal:4318");
    }),
  );

  const minimalWebFlags = (baseDir: string) => ({
    mode: Option.some("web" as const),
    port: Option.some(3773),
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
  });

  it.effect(
    "resolves each signal's endpoint through T3CODE_OTLP_*_URL, an OTEL endpoint, the bootstrap envelope, and persisted Settings, in that order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-cli-config-otel-precedence-",
        });
        const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
        yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
        yield* fs.writeFileString(
          derivedPaths.settingsPath,
          `${JSON.stringify({ observability: { otlpLogsUrl: "http://settings:4318/v1/logs" } })}\n`,
        );

        const fd = yield* openBootstrapFd(
          makeDesktopBootstrap({
            otlpMetricsUrl: "http://bootstrap:4318/v1/metrics",
            otlpLogsUrl: "",
          }),
        );

        const resolved = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some("desktop"),
            port: Option.some(4888),
            bootstrapFd: Option.some(fd),
          },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_OTLP_TRACES_URL: "http://t3:4318/v1/traces",
                    T3CODE_OTLP_HEADERS: "x-key=secret",
                    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel-traces:4318/custom",
                    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://otel-metrics:4318/custom",
                    OTEL_EXPORTER_OTLP_HEADERS: "x-key=otel",
                  },
                }),
              ),
              NetService.layer,
            ),
          ),
        );

        expect(resolved.otlpTracesUrl).toBe("http://t3:4318/v1/traces");
        expect(resolved.otlpTracesExport.headers).toEqual({ "x-key": "secret" });
        expect(resolved.otlpMetricsUrl).toBe("http://otel-metrics:4318/custom");
        expect(resolved.otlpMetricsExport).toEqual({
          ...DEFAULT_SIGNAL_EXPORT,
          protocol: "http/protobuf",
          headers: { "x-key": "otel" },
        });
        expect(resolved.otlpLogsUrl).toBe("http://settings:4318/v1/logs");
        expect(resolved.otlpLogsExport.headers).toEqual({ "x-key": "secret" });
      }),
  );

  it.effect(
    "exports nothing for a signal an OTEL endpoint claimed with a protocol or headers that do not read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-cli-config-otel-off-",
        });
        const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
        yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
        yield* fs.writeFileString(
          derivedPaths.settingsPath,
          `${JSON.stringify({ observability: { otlpLogsUrl: "http://settings:4318/v1/logs" } })}\n`,
        );

        const fd = yield* openBootstrapFd(
          makeDesktopBootstrap({ otlpMetricsUrl: "http://bootstrap:4318/v1/metrics" }),
        );

        const resolved = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some("desktop"),
            port: Option.some(4888),
            bootstrapFd: Option.some(fd),
          },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_OTLP_TRACES_URL: "http://t3:4318/v1/traces",
                    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
                    OTEL_EXPORTER_OTLP_HEADERS: "x-key=%zz",
                  },
                }),
              ),
              NetService.layer,
            ),
          ),
        );

        expect(resolved.otlpTracesUrl).toBe("http://t3:4318/v1/traces");
        expect(resolved.otlpMetricsUrl).toBeUndefined();
        expect(resolved.otlpLogsUrl).toBeUndefined();
      }),
  );
});
