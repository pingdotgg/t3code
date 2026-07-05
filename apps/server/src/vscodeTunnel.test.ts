import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "./processRunner.ts";
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
