import type { OpencodeClient } from "@opencode-ai/sdk-next/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ChatAttachment,
  OpenCode2Settings,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OpenCode2Runtime from "../provider/opencode2Runtime.ts";
import * as OpenCode2TextGeneration from "./OpenCode2TextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

function assistantTextResponse(text: string) {
  return {
    data: {
      data: [
        {
          type: "user",
          id: "msg-user",
          text: "prompt",
          time: { created: 1 },
        },
        {
          type: "assistant",
          id: "msg-assistant",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode" },
          content: [{ type: "text", id: "part-text", text }],
          time: { created: 2 },
        },
      ],
    },
  };
}

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    startError: undefined as OpenCode2Runtime.OpenCode2RuntimeError | undefined,
    runningServers: [] as boolean[],
    closeCalls: [] as string[],
    connectCalls: [] as Array<{
      binaryPath: string;
      serverUrl?: string | null;
      serverPassword?: string | null;
    }>,
    clientConnections: [] as Array<{
      baseUrl: string;
      directory: string;
      serverPassword: string;
    }>,
    sessionCreateRequests: [] as Array<Record<string, unknown>>,
    sessionPromptRequests: [] as Array<Record<string, unknown>>,
    sessionWaitRequests: [] as Array<Record<string, unknown>>,
    sessionContextRequests: [] as Array<Record<string, unknown>>,
    sessionInterruptRequests: [] as Array<Record<string, unknown>>,
    assistantText: JSON.stringify({
      subject: "Add OpenCode 2 generation",
      body: "Use the stateless generation endpoint.",
    }),
    promptErrors: [] as Array<unknown>,
    sessionPromptError: undefined as unknown,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.startError = undefined;
    this.state.runningServers.length = 0;
    this.state.closeCalls.length = 0;
    this.state.connectCalls.length = 0;
    this.state.clientConnections.length = 0;
    this.state.sessionCreateRequests.length = 0;
    this.state.sessionPromptRequests.length = 0;
    this.state.sessionWaitRequests.length = 0;
    this.state.sessionContextRequests.length = 0;
    this.state.sessionInterruptRequests.length = 0;
    this.state.assistantText = JSON.stringify({
      subject: "Add OpenCode 2 generation",
      body: "Use the stateless generation endpoint.",
    });
    this.state.promptErrors.length = 0;
    this.state.sessionPromptError = undefined;
  },
};

const OpenCode2RuntimeTestDouble: OpenCode2Runtime.OpenCode2Runtime["Service"] = {
  startOpenCode2ServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      if (runtimeMock.state.startError !== undefined) {
        return yield* runtimeMock.state.startError;
      }
      const url = `http://127.0.0.1:${4_500 + runtimeMock.state.startCalls.length}`;
      runtimeMock.state.startCalls.push(binaryPath);
      const serverIndex = runtimeMock.state.runningServers.push(true) - 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        password: `password-${runtimeMock.state.startCalls.length}`,
        exitCode: Effect.never,
        isRunning: Effect.sync(() => runtimeMock.state.runningServers[serverIndex] === true),
      };
    }),
  connectToOpenCode2Server: ({ binaryPath, serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      runtimeMock.state.connectCalls.push({
        binaryPath,
        ...(serverUrl === undefined ? {} : { serverUrl }),
        ...(serverPassword === undefined ? {} : { serverPassword }),
      });
      if (serverUrl && !serverPassword?.trim()) {
        return yield* new OpenCode2Runtime.OpenCode2RuntimeError({
          operation: "connectToOpenCode2Server",
          category: "external-server-password-required",
        });
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4500",
        password: serverPassword ?? "password-1",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  createOpenCode2SdkClient: ({ baseUrl, directory, serverPassword }) => {
    runtimeMock.state.clientConnections.push({ baseUrl, directory, serverPassword });
    const runPrompt = async (parameters: Record<string, unknown>) => {
      runtimeMock.state.sessionPromptRequests.push(parameters);
      if (runtimeMock.state.sessionPromptError !== undefined) {
        throw runtimeMock.state.sessionPromptError;
      }
      const error = runtimeMock.state.promptErrors.shift();
      if (error !== undefined) throw error;
      return {
        data: {
          id: "input-1",
          sessionID: "temporary-session",
          admittedSeq: 1,
          delivery: "queue",
          timeCreated: 1,
          text: parameters.text ?? parameters.prompt,
        },
      };
    };
    return {
      // next-16916 prompt uses the raw hey-api client (flat `{ text }` body).
      client: {
        post: async (options: {
          readonly path?: { readonly sessionID?: string };
          readonly body?: Record<string, unknown>;
        }) =>
          runPrompt({
            sessionID: options.path?.sessionID,
            ...options.body,
          }),
      },
      v2: {
        session: {
          create: async (parameters: Record<string, unknown>) => {
            runtimeMock.state.sessionCreateRequests.push(parameters);
            return { data: { data: { id: "temporary-session" } } };
          },
          prompt: async (parameters: Record<string, unknown>) => runPrompt(parameters),
          wait: async (parameters: Record<string, unknown>) => {
            runtimeMock.state.sessionWaitRequests.push(parameters);
            return { data: undefined };
          },
          context: async (parameters: Record<string, unknown>) => {
            runtimeMock.state.sessionContextRequests.push(parameters);
            return assistantTextResponse(runtimeMock.state.assistantText);
          },
          interrupt: async (parameters: Record<string, unknown>) => {
            runtimeMock.state.sessionInterruptRequests.push(parameters);
            return { data: undefined };
          },
        },
      },
    } as unknown as OpencodeClient;
  },
};

const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode2"),
  model: "opencode/big-pickle",
};
const DEFAULT_COMMIT_INPUT = {
  cwd: process.cwd(),
  branch: "feature/opencode2-generation",
  stagedSummary: "M README.md",
  stagedPatch: "diff --git a/README.md b/README.md",
  modelSelection: DEFAULT_MODEL_SELECTION,
};
const DEFAULT_SETTINGS = Schema.decodeSync(OpenCode2Settings)({
  binaryPath: "fake-opencode2",
});
const EXTERNAL_SETTINGS = Schema.decodeSync(OpenCode2Settings)({
  binaryPath: "fake-opencode2",
  serverUrl: "http://127.0.0.1:9998",
  serverPassword: "external-secret",
});
const EXTERNAL_SETTINGS_WITHOUT_PASSWORD = Schema.decodeSync(OpenCode2Settings)({
  binaryPath: "fake-opencode2",
  serverUrl: "http://127.0.0.1:9998",
});
const IMAGE_ATTACHMENT = Schema.decodeSync(ChatAttachment)({
  type: "image",
  id: "thread-12345678-1234-1234-1234-123456789abc",
  name: "picker.png",
  mimeType: "image/png",
  sizeBytes: 123,
});
const OPENCODE2_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCode2TextGenerationTestLayer = Layer.succeed(
  OpenCode2Runtime.OpenCode2Runtime,
  OpenCode2RuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode2-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

function withOpenCode2TextGeneration<A, E, R>(
  settings: OpenCode2Settings,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const textGeneration = yield* OpenCode2TextGeneration.makeOpenCode2TextGeneration(settings);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE2_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCode2TextGenerationTestLayer)("OpenCode2TextGeneration", (it) => {
  it.effect("generates with Big Pickle, reuses the local server, and closes it after idling", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const input = {
          ...DEFAULT_COMMIT_INPUT,
          policy: {
            kind: "custom" as const,
            commitInstructions: "Use concise release-note wording.",
            inferRepositoryConventions: false,
          },
        };
        const first = yield* textGeneration.generateCommitMessage(input);
        const second = yield* textGeneration.generateCommitMessage(input);

        expect(first).toEqual({
          subject: "Add OpenCode 2 generation",
          body: "Use the stateless generation endpoint.",
        });
        expect(second).toEqual(first);
        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode2"]);
        expect(runtimeMock.state.sessionCreateRequests).toHaveLength(2);
        expect(runtimeMock.state.sessionCreateRequests[0]).toMatchObject({
          location: { directory: process.cwd() },
          model: { providerID: "opencode", id: "big-pickle" },
        });
        expect(runtimeMock.state.sessionPromptRequests).toHaveLength(2);
        const firstPrompt = runtimeMock.state.sessionPromptRequests[0] as
          | { text?: string }
          | undefined;
        expect(firstPrompt?.text).toContain("Use concise release-note wording.");
        expect(runtimeMock.state.closeCalls).toEqual([]);

        yield* advanceIdleClock;

        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4500"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces the shared local server when its process has exited", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const first = yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_INPUT);
        runtimeMock.state.runningServers[0] = false;
        const [second, third] = yield* Effect.all(
          [
            textGeneration.generateCommitMessage(DEFAULT_COMMIT_INPUT),
            textGeneration.generateCommitMessage(DEFAULT_COMMIT_INPUT),
          ],
          { concurrency: "unbounded" },
        );

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode2", "fake-opencode2"]);
        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4500"]);
        expect(runtimeMock.state.clientConnections.map((connection) => connection.baseUrl)).toEqual(
          ["http://127.0.0.1:4500", "http://127.0.0.1:4501", "http://127.0.0.1:4501"],
        );
      }),
    ),
  );

  it.effect("uses the configured authenticated server without spawning", () =>
    withOpenCode2TextGeneration(EXTERNAL_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_INPUT);

        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.connectCalls).toEqual([
          {
            binaryPath: "fake-opencode2",
            serverUrl: "http://127.0.0.1:9998",
            serverPassword: "external-secret",
          },
        ]);
        expect(runtimeMock.state.clientConnections).toEqual([
          {
            baseUrl: "http://127.0.0.1:9998",
            directory: process.cwd(),
            serverPassword: "external-secret",
          },
        ]);
      }),
    ),
  );

  it.effect("keeps startup failures static while preserving their immediate cause", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const secret = "OPEN_CODE_2_STARTUP_SECRET";
        const cause = new Error(secret);
        runtimeMock.state.startError = new OpenCode2Runtime.OpenCode2RuntimeError({
          operation: "startOpenCode2ServerProcess",
          category: "startup-failed",
          cause,
        });

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode 2 server startup failed.");
        expect(error.message).not.toContain(secret);
        expect(error.cause).toMatchObject({
          _tag: "OpenCode2RuntimeError",
          cause,
        });
      }),
    ),
  );

  it.effect("rejects an external server without its required password", () =>
    withOpenCode2TextGeneration(EXTERNAL_SETTINGS_WITHOUT_PASSWORD, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_INPUT)
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("OpenCode 2 server connection failed.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCode2RuntimeError",
          category: "external-server-password-required",
        });
        expect(runtimeMock.state.clientConnections).toEqual([]);
      }),
    ),
  );

  it.effect("generates PR content and branch names through the shared endpoint", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.assistantText =
          '{"title":"Add OpenCode 2 text generation","body":"## Summary\\n\\n- Add generation"}';
        const pr = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/opencode2-generation",
          commitSummary: "Add generation",
          changeRequestTemplate: "## Change summary\n\n## Validation",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a b/a",
          policy: {
            kind: "custom",
            changeRequestInstructions: "Call out the rollout plan.",
            inferRepositoryConventions: false,
          },
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        runtimeMock.state.assistantText = '{"branch":"opencode2-text-generation"}';
        const branch = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add OpenCode 2 text generation.",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        expect(pr).toEqual({
          title: "Add OpenCode 2 text generation",
          body: "## Summary\n\n- Add generation",
        });
        const prPrompt = runtimeMock.state.sessionPromptRequests[0] as
          | { text?: string }
          | undefined;
        expect(prPrompt?.text).toContain("Call out the rollout plan.");
        expect(prPrompt?.text).toContain("## Change summary");
        expect(branch).toEqual({ branch: "opencode2-text-generation" });
      }),
    ),
  );

  it.effect("uses prior title context when regenerating a thread title", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.assistantText = '{"title":"Repair OpenCode 2 status handling"}';

        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "The status probe should redact server credentials.",
          previousTitle: "Investigate provider status",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        expect(result).toEqual({ title: "Repair OpenCode 2 status handling" });
        const titlePrompt = runtimeMock.state.sessionPromptRequests[0] as
          | { text?: string }
          | undefined;
        expect(titlePrompt?.text).toContain(
          'The previous title was "Investigate provider status".',
        );
        expect(titlePrompt?.text).toContain(
          "Regenerate the title for an existing T3 Code thread so the user can recognize it weeks later.",
        );
      }),
    ),
  );

  it.effect("rejects model slugs without a provider prefix before calling the SDK", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration
          .generateCommitMessage({
            ...DEFAULT_COMMIT_INPUT,
            modelSelection: {
              ...DEFAULT_MODEL_SELECTION,
              model: "big-pickle",
            },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("must use the 'provider/model' format");
        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.sessionPromptRequests).toEqual([]);
      }),
    ),
  );

  it.effect("retries the exact model bootstrap race and then succeeds", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptErrors.push(
          new Error("Model unavailable: opencode/big-pickle"),
          new Error("Model unavailable: opencode/big-pickle"),
        );
        const fiber = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_INPUT)
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(fiber);

        expect(result.subject).toBe("Add OpenCode 2 generation");
        expect(runtimeMock.state.sessionPromptRequests).toHaveLength(3);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "uses a temporary session for an agent selection and cleans it up after generation",
    () =>
      withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          runtimeMock.state.assistantText = '{"title":"Fix the model picker icon"}';

          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "The provider icon is missing.",
            attachments: [IMAGE_ATTACHMENT],
            modelSelection: {
              ...DEFAULT_MODEL_SELECTION,
              options: [{ id: "agent", value: "build" }],
            },
          });

          expect(result).toEqual({ title: "Fix the model picker icon" });
          expect(runtimeMock.state.sessionCreateRequests).toEqual([
            {
              model: { providerID: "opencode", id: "big-pickle" },
              location: { directory: process.cwd() },
              agent: "build",
            },
          ]);
          expect(runtimeMock.state.sessionPromptRequests).toHaveLength(1);
          expect(runtimeMock.state.sessionPromptRequests[0]).toMatchObject({
            sessionID: "temporary-session",
          });
          const agentPrompt = runtimeMock.state.sessionPromptRequests[0] as
            | { text?: string }
            | undefined;
          expect(agentPrompt?.text).toContain("Attachment metadata:");
          expect(agentPrompt?.text).toContain("picker.png");
          expect(runtimeMock.state.sessionWaitRequests).toEqual([
            { sessionID: "temporary-session" },
          ]);
          expect(runtimeMock.state.sessionContextRequests).toEqual([
            { sessionID: "temporary-session" },
          ]);
          expect(runtimeMock.state.sessionInterruptRequests).toEqual([
            { sessionID: "temporary-session" },
          ]);
        }),
      ),
  );

  it.effect("interrupts a temporary session when generation fails", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const sdkCause = new Error("generation unavailable");
        runtimeMock.state.sessionPromptError = sdkCause;

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "The provider icon is missing.",
            attachments: [IMAGE_ATTACHMENT],
            modelSelection: {
              ...DEFAULT_MODEL_SELECTION,
              options: [{ id: "agent", value: "build" }],
            },
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("session.prompt request failed");
        expect(error.message).not.toContain(sdkCause.message);
        expect(error.cause).toMatchObject({
          _tag: "OpenCode2RuntimeError",
          category: "sdk-request-failed",
          operation: "session.prompt",
          cause: sdkCause,
        });
        expect(runtimeMock.state.sessionInterruptRequests).toEqual([
          { sessionID: "temporary-session" },
        ]);
      }),
    ),
  );

  it.effect("rejects blank generation output as a typed error", () =>
    withOpenCode2TextGeneration(DEFAULT_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.assistantText = "   ";

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_INPUT)
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("OpenCode 2 returned empty output");
      }),
    ),
  );
});
