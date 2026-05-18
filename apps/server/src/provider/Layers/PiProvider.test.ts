import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { PiSettings } from "@t3tools/contracts";
import {
  checkPiProviderStatus,
  getPiFallbackModels,
  parsePiConfigModelDefaults,
} from "./PiProvider.ts";

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

describe("parsePiConfigModelDefaults", () => {
  it("reads defaultModel from Pi settings.json", () => {
    expect(
      parsePiConfigModelDefaults(`{
        "defaultProvider": "anthropic",
        "defaultModel": "claude-haiku-4-5"
      }`),
    ).toEqual({
      defaultModel: "claude-haiku-4-5",
      defaultProvider: "anthropic",
      malformed: false,
    });
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

  it("reports expired Pi OAuth as unauthenticated", async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-auth-test-" });
        const piDir = path.join(home, ".pi", "agent");
        yield* fs.makeDirectory(piDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(piDir, "settings.json"),
          [
            "{",
            '  "defaultProvider": "anthropic",',
            '  "defaultModel": "claude-opus-4-6"',
            "}",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(piDir, "auth.json"),
          [
            "{",
            '  "anthropic": {',
            '    "type": "oauth",',
            '    "access": "redacted",',
            '    "refresh": "redacted",',
            `    "expires": ${Date.UTC(2026, 2, 24)}`,
            "  }",
            "}",
          ].join("\n"),
        );
        const layer = Layer.merge(
          NodeServices.layer,
          mockSpawnerLayer((command, args) => {
            if (args[0] === "-lc") return { stdout: "", code: 1 };
            expect(command).toBe("/tmp/bin/pi");
            return { stdout: "0.62.0\n", code: 0 };
          }),
        );

        return yield* checkPiProviderStatus(
          makePiSettings({
            binaryPath: "/opt/homebrew/bin/pi-acp",
            piBinaryPath: "/tmp/bin/pi",
          }),
          {
            HOME: home,
            PATH: "",
          },
        ).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    expect(snapshot.status).toBe("error");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toContain("expired");
    expect(snapshot.message).toContain("anthropic");
  });

  it("explains the Codex login path for missing GPT-5.5 Pi auth", async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-codex-auth-test-" });
        const piDir = path.join(home, ".pi", "agent");
        yield* fs.makeDirectory(piDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(piDir, "settings.json"),
          [
            "{",
            '  "defaultProvider": "openai-codex",',
            '  "defaultModel": "gpt-5.5"',
            "}",
          ].join("\n"),
        );
        yield* fs.writeFileString(path.join(piDir, "auth.json"), "{}");
        const layer = Layer.merge(
          NodeServices.layer,
          mockSpawnerLayer((command, args) => {
            if (args[0] === "-lc") return { stdout: "", code: 1 };
            expect(command).toBe("/tmp/bin/pi");
            return { stdout: "0.62.0\n", code: 0 };
          }),
        );

        return yield* checkPiProviderStatus(
          makePiSettings({
            binaryPath: "/opt/homebrew/bin/pi-acp",
            piBinaryPath: "/tmp/bin/pi",
          }),
          {
            HOME: home,
            PATH: "",
          },
        ).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    expect(snapshot.status).toBe("error");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.models[0]?.slug).toBe("gpt-5.5");
    expect(snapshot.models.map((model) => model.slug)).toContain("gpt-5.4");
    expect(snapshot.message).toContain("openai-codex");
    expect(snapshot.message).toContain("ChatGPT Plus/Pro (Codex)");
  });
});
