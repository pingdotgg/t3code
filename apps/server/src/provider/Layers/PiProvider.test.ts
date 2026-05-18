import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { PiSettings } from "@t3tools/contracts";
import { checkPiProviderStatus, getPiFallbackModels } from "./PiProvider.ts";

const encoder = new TextEncoder();
const decodePiSettings = Schema.decodeSync(PiSettings);

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

const makePiSettings = (overrides?: Partial<PiSettings>): PiSettings =>
  decodePiSettings({
    enabled: true,
    binaryPath: "pi-acp",
    piBinaryPath: "pi",
    customModels: [],
    ...overrides,
  });

describe("getPiFallbackModels", () => {
  it("includes the fallback Pi model and custom models", () => {
    const models = getPiFallbackModels(makePiSettings({ customModels: ["openai/gpt-5"] }));
    expect(models.map((model) => [model.slug, model.name, model.isCustom])).toEqual([
      ["pi-default", "Pi Default", false],
      ["openai/gpt-5", "openai/gpt-5", true],
    ]);
  });
});

describe("checkPiProviderStatus", () => {
  it("detects pi-acp without spawning it, then verifies the Pi CLI", async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const layer = Layer.merge(
          NodeServices.layer,
          mockSpawnerLayer((command, args) => {
            if (args[0] === "-lc") return { stdout: "", code: 1 };
            expect(command).toBe("/tmp/bin/pi");
            expect(args).toEqual(["--version"]);
            return { stdout: "0.62.0\n", code: 0 };
          }),
        );

        return yield* checkPiProviderStatus(
          makePiSettings({
            binaryPath: "/opt/homebrew/bin/pi-acp",
            piBinaryPath: "/tmp/bin/pi",
          }),
          {
            HOME: "/tmp/no-pi-config",
            PATH: "",
          },
        ).pipe(Effect.provide(layer));
      }),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("0.62.0");
    expect(snapshot.models[0]?.slug).toBe("pi-default");
  });
});
