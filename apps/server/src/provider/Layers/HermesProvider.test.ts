import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HermesSettings } from "@t3tools/contracts";
import {
  checkHermesProviderStatus,
  getHermesFallbackModels,
  parseHermesConfigModelDefaults,
  resolveHermesBinary,
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

const makeTempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-test-" });
});

const writeTestFile = (filePath: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
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
      { defaultModel: "gpt-5.5", malformed: false },
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
      { defaultModel: null, malformed: true },
    );
  });

  it("parses quoted model defaults and strips inline comments", () => {
    assert.deepEqual(
      parseHermesConfigModelDefaults(`
model:
  default: "gpt-5.5" # selected in hermes model
`),
      { defaultModel: "gpt-5.5", malformed: false },
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
        mockSpawnerLayer((command, args) => {
          if (args[0] === "-lc") {
            assert.equal(command, "/bin/zsh");
            return { stdout: "", code: 1 };
          }
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

  it.effect("uses the detected common macOS binary path for the default hermes command", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeTempHome;
      const binaryPath = path.join(home, ".local/bin/hermes");
      yield* writeTestFile(binaryPath, "");

      const resolution = yield* resolveHermesBinary(makeHermesSettings(), {
        HOME: home,
      });

      assert.equal(resolution.binaryPath, binaryPath);
      assert.equal(resolution.suggestedBinaryPath, binaryPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("suggests a detected path when an explicit binary path is invalid", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeTempHome;
      const binaryPath = path.join(home, ".local/bin/hermes");
      yield* writeTestFile(binaryPath, "");

      const snapshot = yield* checkHermesProviderStatus(
        makeHermesSettings({ binaryPath: path.join(home, "missing/hermes") }),
        { HOME: home },
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.suggestedBinaryPath, binaryPath);
      assert.match(snapshot.message ?? "", /Detected Hermes/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shows the configured Hermes model from config.yaml", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeTempHome;
      yield* writeTestFile(
        path.join(home, ".hermes/config.yaml"),
        `
model:
  provider: openai-codex
  default: gpt-5.5
`,
      );
      const layer = mockSpawnerLayer((command, args) => {
        if (args[0] === "-lc") return { stdout: "", code: 1 };
        assert.equal(command, "hermes");
        return { stdout: "Hermes Agent v0.11.0\n", code: 0 };
      });

      const snapshot = yield* checkHermesProviderStatus(makeHermesSettings(), {
        HOME: home,
      }).pipe(Effect.provide(layer));

      assert.equal(snapshot.models[0]?.slug, "gpt-5.5");
      assert.equal(snapshot.models[0]?.name, "GPT 5.5");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("guides setup when Hermes config has no model.default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeTempHome;
      yield* writeTestFile(
        path.join(home, ".hermes/config.yaml"),
        "model:\n  provider: openai-codex\n",
      );
      const layer = mockSpawnerLayer((_command, args) => {
        if (args[0] === "-lc") return { stdout: "", code: 1 };
        return { stdout: "Hermes Agent v0.11.0\n", code: 0 };
      });

      const snapshot = yield* checkHermesProviderStatus(makeHermesSettings(), {
        HOME: home,
      }).pipe(Effect.provide(layer));

      assert.equal(snapshot.status, "ready");
      assert.match(snapshot.message ?? "", /hermes model/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces stderr when the Hermes CLI health check exits nonzero", () =>
    Effect.gen(function* () {
      const layer = Layer.merge(
        NodeServices.layer,
        mockSpawnerLayer((_command, args) => {
          if (args[0] === "-lc") return { stdout: "", code: 1 };
          return { stderr: "ACP failed to start: missing provider credentials", code: 2 };
        }),
      );

      const snapshot = yield* checkHermesProviderStatus(makeHermesSettings(), {
        HOME: "/tmp/no-hermes-config",
      }).pipe(Effect.provide(layer));

      assert.equal(snapshot.status, "warning");
      assert.match(snapshot.message ?? "", /ACP failed to start/);
    }),
  );
});
