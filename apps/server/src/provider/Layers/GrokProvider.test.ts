import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GrokSettings } from "@t3tools/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Grok is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

const makeSpawnHandle = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(input.stdout ?? "")),
    stderr: Stream.encodeText(input.stderr ? Stream.make(input.stderr) : Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const spawnArgs = (command: { readonly _tag: string; readonly args?: ReadonlyArray<string> }) =>
  command._tag === "StandardCommand" ? (command.args ?? []) : [];

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () => {
    const secretStderr = "broken grok install: secret-token-value";
    const spawner = ChildProcessSpawner.make((command) => {
      if (spawnArgs(command).includes("--version")) {
        return Effect.succeed(makeSpawnHandle({ stderr: `${secretStderr}\n`, exitCode: 2 }));
      }
      return Effect.succeed(makeSpawnHandle({ stderr: "unexpected grok spawn\n", exitCode: 1 }));
    });

    return Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath: "grok" }),
      ).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    });
  });

  it.effect("reports an error when ACP model discovery is unavailable", () => {
    const spawner = ChildProcessSpawner.make((command) => {
      const args = spawnArgs(command);
      if (args.includes("--version")) {
        return Effect.succeed(makeSpawnHandle({ stdout: "grok-cli 0.0.99\n" }));
      }
      if (args.includes("inspect")) {
        return Effect.succeed(makeSpawnHandle({ stdout: JSON.stringify({ skills: [] }) }));
      }
      return Effect.succeed(makeSpawnHandle({ stderr: "ACP probe unavailable\n", exitCode: 1 }));
    });

    return Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath: "grok" }),
      ).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
      expect(snapshot.skills).toEqual([]);
    });
  });

  it.effect("attaches inspect skills even when ACP model discovery fails", () => {
    const inspectCwds: Array<string | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = spawnArgs(command);
      if (args.includes("inspect")) {
        inspectCwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
        return Effect.succeed(
          makeSpawnHandle({
            stdout: JSON.stringify({
              skills: [
                {
                  name: "tdd",
                  description: "Test-driven development.",
                  source: {
                    type: "user",
                    path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
                  },
                  userInvocable: true,
                },
              ],
            }),
          }),
        );
      }
      if (args.includes("--version")) {
        return Effect.succeed(makeSpawnHandle({ stdout: "grok 1.0.5\n" }));
      }
      return Effect.succeed(
        makeSpawnHandle({ stderr: "ACP probe should not block skill discovery\n", exitCode: 1 }),
      );
    });

    return Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath: "grok" }),
        {},
        "C:\\workspaces\\demo",
      ).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

      expect(inspectCwds).toEqual(["C:\\workspaces\\demo"]);
      expect(snapshot.skills).toEqual([
        {
          name: "tdd",
          description: "Test-driven development.",
          path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("ACP startup failed");
    });
  });
});
