import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HermesSettings } from "@t3tools/contracts";
import {
  checkHermesProviderStatus,
  getHermesFallbackModels,
  parseHermesConfigModelDefaults,
} from "./HermesProvider.ts";

const encoder = new TextEncoder();
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

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

const makeHermesSettings = (overrides?: Partial<HermesSettings>): HermesSettings =>
  decodeHermesSettings({
    enabled: true,
    binaryPath: "hermes",
    customModels: [],
    ...overrides,
  });

describe("parseHermesConfigModelDefaults", () => {
  it("reads the model.default value from Hermes config.yaml", () => {
    assert.deepEqual(
      parseHermesConfigModelDefaults(`
model:
  provider: openai-codex
  base_url: https://chatgpt.com/backend-api/codex
  default: gpt-5.5
`),
      { defaultModel: "gpt-5.5" },
    );
  });

  it("ignores unrelated default keys outside the model block", () => {
    assert.deepEqual(
      parseHermesConfigModelDefaults(`
default: wrong
model:
  provider: openai-codex
tools:
  default: also-wrong
`),
      { defaultModel: null },
    );
  });
});

describe("getHermesFallbackModels", () => {
  it("keeps a built-in fallback model plus configured custom models", () => {
    const models = getHermesFallbackModels(
      makeHermesSettings({ customModels: ["nous/hermes-4", "hermes-default"] }),
    );

    assert.deepEqual(
      models.map((model) => [model.slug, model.name, model.isCustom]),
      [
        ["hermes-default", "Hermes Default", false],
        ["nous/hermes-4", "nous/hermes-4", true],
      ],
    );
  });
});

describe("checkHermesProviderStatus", () => {
  it.effect("reports ready status and parses --version output", () =>
    Effect.gen(function* () {
      const layer = Layer.merge(
        NodeServices.layer,
        mockSpawnerLayer((_command, args) => {
          assert.deepEqual(args, ["--version"]);
          return { stdout: "Hermes Agent v0.11.0\n", code: 0 };
        }),
      );
      const snapshot = yield* checkHermesProviderStatus(makeHermesSettings(), {
        HOME: "/tmp/no-hermes-config",
      }).pipe(Effect.provide(layer));

      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.version, "0.11.0");
      assert.equal(snapshot.models[0]?.slug, "hermes-default");
    }),
  );
});
