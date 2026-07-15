import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "./processRunner.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as VSCodeTunnel from "./vscodeTunnel.ts";

describe("vscode tunnel status resolution", () => {
  it.effect("parses connected status when JSON is preceded by non-JSON output", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.status.checked).toBe(true);
      expect(resolved.status.connected).toBe(true);
      expect(resolved.status.machineName).toBe("devbox");
      expect(resolved.status.serviceInstalled).toBe(true);
      expect(resolved.tunnel).toEqual({ machineName: "devbox" });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: [
                "Some informational output...",
                '{"tunnel":{"name":"devbox","tunnel":"connected"},"service_installed":true}',
              ].join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("ignores stray quotes before the status JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.status.connected).toBe(true);
      expect(resolved.tunnel).toEqual({ machineName: "devbox" });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: [
                'warning: unexpected " in configuration',
                '{"tunnel":{"name":"devbox","tunnel":"connected"},"service_installed":true}',
              ].join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("shares cached tunnel status across snapshot readers", () => {
    let runCount = 0;
    const monitorLayer = VSCodeTunnel.monitorLayer.pipe(
      Layer.provide(ServerSettings.layerTest({ enableVSCodeRemoteTunnels: true })),
      Layer.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              runCount += 1;
              return {
                stdout:
                  '{"tunnel":{"name":"devbox","tunnel":"connected"},"service_installed":true}',
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const monitor = yield* VSCodeTunnel.VSCodeTunnelMonitor;
      const snapshots = yield* Effect.all(
        [monitor.getSnapshot({ enabled: true }), monitor.getSnapshot({ enabled: true })],
        { concurrency: "unbounded" },
      );

      expect(runCount).toBe(1);
      expect(snapshots[0]).toEqual(snapshots[1]);
    }).pipe(Effect.provide(monitorLayer));
  });

  it.effect("parses connected status when JSON is pretty-printed", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.status.checked).toBe(true);
      expect(resolved.status.connected).toBe(true);
      expect(resolved.status.machineName).toBe("devbox");
      expect(resolved.status.serviceInstalled).toBe(true);
      expect(resolved.tunnel).toEqual({ machineName: "devbox" });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: [
                "Some informational output...",
                "{",
                '  "tunnel": {',
                '    "name": "devbox",',
                '    "tunnel": "connected"',
                "  },",
                '  "service_installed": true',
                "}",
                "Trailing output line",
              ].join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("accepts tunnel:null and preserves service status", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.tunnel).toBeNull();
      expect(resolved.status).toEqual({
        checked: true,
        connected: false,
        machineName: null,
        serviceInstalled: true,
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: '{"tunnel":null,"service_installed":true}',
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("skips unrelated JSON and parses the status payload", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.status.checked).toBe(true);
      expect(resolved.status.connected).toBe(true);
      expect(resolved.status.machineName).toBe("devbox");
      expect(resolved.status.serviceInstalled).toBe(true);
      expect(resolved.tunnel).toEqual({ machineName: "devbox" });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: [
                '{"log":"starting"}',
                '{"tunnel":{"name":"devbox","tunnel":"connected"},"service_installed":true}',
              ].join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("parses status JSON even when stray closing braces precede the payload", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.status.checked).toBe(true);
      expect(resolved.status.connected).toBe(true);
      expect(resolved.status.machineName).toBe("devbox");
      expect(resolved.status.serviceInstalled).toBe(true);
      expect(resolved.tunnel).toEqual({ machineName: "devbox" });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: [
                "noise } }",
                '{"tunnel":{"name":"devbox","tunnel":"connected"},"service_installed":true}',
              ].join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

  it.effect("returns unavailable status when no JSON object is present", () =>
    Effect.gen(function* () {
      const resolved = yield* VSCodeTunnel.resolveVSCodeTunnel({
        enabled: true,
      });

      expect(resolved.tunnel).toBeNull();
      expect(resolved.status).toEqual({
        checked: true,
        connected: false,
        machineName: null,
        serviceInstalled: null,
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: "status unavailable",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );
});
