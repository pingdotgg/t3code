import { OpenCodeSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NetService from "@t3tools/shared/Net";
import { beforeEach, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeTextGeneration from "./OpenCodeTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    promptUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    sessionCreateError: undefined as unknown,
    sessionResult: undefined as { data?: { id: string } } | undefined,
    promptRequestError: undefined as unknown,
    promptResult: undefined as
      | { data?: { info?: { error?: unknown }; parts?: Array<unknown> } }
      | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.promptUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.sessionCreateError = undefined;
    this.state.sessionResult = undefined;
    this.state.promptRequestError = undefined;
    this.state.promptResult = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntimeShape = {
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
        create: async () => {
          if (runtimeMock.state.sessionCreateError !== undefined) {
            throw runtimeMock.state.sessionCreateError;
          }
          return runtimeMock.state.sessionResult ?? { data: { id: `${baseUrl}/session` } };
        },
        prompt: async () => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          if (runtimeMock.state.promptRequestError !== undefined) {
            throw runtimeMock.state.promptRequestError;
          }
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
    }) as unknown as ReturnType<OpenCodeRuntime.OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5",
};
const DEFAULT_COMMIT_MESSAGE_INPUT = {
  cwd: process.cwd(),
  branch: "feature/opencode-reuse",
  stagedSummary: "M README.md",
  stagedPatch: "diff --git a/README.md b/README.md",
  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-existing-server-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
});
const EXISTING_SERVER_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

function withOpenCodeTextGeneration<A, E, R>(
  settings: OpenCodeSettings,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const textGeneration = yield* OpenCodeTextGeneration.makeOpenCodeTextGeneration(settings);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

beforeEach(() => {
  runtimeMock.reset();
});

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGeneration", (it) => {
  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
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
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
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
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves the SDK cause when session creation fails", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const sdkCause = new Error("session endpoint unavailable");
        runtimeMock.state.sessionCreateError = sdkCause;

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("OpenCode session.create request failed.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationSessionRequestError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          cause: sdkCause,
        });
        expect((error.cause as { cause: unknown }).cause).toBe(sdkCause);
      }),
    ),
  );

  it.effect("reports a missing session payload without manufacturing a cause", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.sessionResult = {};

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode session.create returned no session payload.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationSessionPayloadError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );

  it.effect("preserves the SDK cause and request context when prompting fails", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const sdkCause = new Error("prompt endpoint unavailable");
        runtimeMock.state.promptRequestError = sdkCause;

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode session.prompt request failed.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationPromptRequestError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          cause: sdkCause,
        });
        expect((error.cause as { cause: unknown }).cause).toBe(sdkCause);
      }),
    ),
  );

  it.effect("returns a typed empty-output error for malformed and blank response parts", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [null, { type: "tool" }, { type: "text", text: "   " }],
          },
        };

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode returned empty output.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationEmptyOutputError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          responsePartCount: 3,
          textPartCount: 1,
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );

  it.effect("parses JSON returned as plain text output", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
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
    ),
  );

  it.effect("surfaces the upstream OpenCode structured-output error message", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
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

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("Model did not produce structured output");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationPromptResponseError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          providerErrorName: "StructuredOutputError",
          providerMessage: "Model did not produce structured output",
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGeneration with configured server URL",
  (it) => {
    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
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
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
