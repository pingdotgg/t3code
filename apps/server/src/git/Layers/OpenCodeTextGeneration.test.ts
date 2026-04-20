import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { NetService } from "@t3tools/shared/Net";
import { beforeEach, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { OpenCodeTextGenerationLive } from "./OpenCodeTextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    promptUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    promptResult: undefined as
      | { data?: { info?: { error?: unknown }; parts?: Array<{ type: string; text?: string }> } }
      | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.promptUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.promptResult = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      // The production runtime binds server lifetime to the caller's scope.
      // Mirror that here so the closeCalls probe observes scope close.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async () => ({ data: { id: `${baseUrl}/session` } }),
        prompt: async () => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "opencode" as const,
  model: "openai/gpt-5",
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationTestLayer = OpenCodeTextGenerationLive.pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
        },
      },
    }),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeTextGenerationExistingServerTestLayer = OpenCodeTextGenerationLive.pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-existing-server-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGenerationLive", (it) => {
  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* advanceIdleClock;

      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      yield* advanceIdleClock;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["fake-opencode", "fake-opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns a typed empty-output error when OpenCode returns no text parts", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = { data: {} };
      const textGeneration = yield* TextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("OpenCode returned empty output.");
    }),
  );

  it.effect("parses JSON returned as plain text output", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [
            {
              type: "text",
              text: 'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}',
            },
          ],
        },
      };
      const textGeneration = yield* TextGeneration;

      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(result).toEqual({
        subject: "Tighten OpenCode parsing",
        body: "Handle JSON text output locally.",
      });
    }),
  );

  it.effect("surfaces the upstream OpenCode structured-output error message", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          info: {
            error: {
              name: "StructuredOutputError",
              data: {
                message: "Model did not produce structured output",
                retries: 2,
              },
            },
          },
        },
      };
      const textGeneration = yield* TextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("Model did not produce structured output");
    }),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGenerationLive with configured server URL",
  (it) => {
    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:9999",
          "http://127.0.0.1:9999",
        ]);
        expect(runtimeMock.state.authHeaders).toEqual([
          `Basic ${btoa("opencode:secret-password")}`,
          `Basic ${btoa("opencode:secret-password")}`,
        ]);

        yield* advanceIdleClock;

        expect(runtimeMock.state.closeCalls).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
