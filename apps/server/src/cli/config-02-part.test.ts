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
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import { deriveServerPaths } from "../config.ts";
import { resolveServerConfig } from "./config.ts";

import { deriveExplicitServerPaths, minimalDesktopFlags, encodeDesktopBootstrap, encodeUnknownJson, makeDesktopBootstrap, liveProcess } from "./config-fixtures.testkit.ts";
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
          lan: Option.none(),
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
  it.effect("uses the automatic port selector only when no port is configured", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-auto-port-" })),
      );
      const selected: number[] = [];
      const selectAutomaticPort = (preferred: number) =>
        Effect.sync(() => {
          selected.push(preferred);
          return 50_123;
        });
      const resolvePort = (flags: {
        readonly mode?: Option.Option<"web" | "desktop">;
        readonly port: Option.Option<number>;
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
      expect(selected).toEqual([3773]);
      expect(yield* resolvePort({ port: Option.some(8788) })).toBe(8788);
      expect(
        yield* resolvePort({ mode: Option.some("desktop" as const), port: Option.none() }),
      ).toBe(3773);
      expect(selected).toEqual([3773]);
    }),
  );
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
        expect(resolved).toMatchObject({
          otlpTracesVariable: "T3CODE_OTLP_TRACES_URL",
          otlpMetricsVariable: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        });
        expect(resolved.otlpLogsVariable).toBeUndefined();
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
    lan: Option.none<boolean>(),
  });




});
