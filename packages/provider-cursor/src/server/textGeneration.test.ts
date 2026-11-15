import type { AgentOptions, RunResult, SDKMessage } from "@cursor/sdk";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./textGeneration.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => ({
  messages: [] as SDKMessage[],
  create: vi.fn<(options: AgentOptions) => Promise<unknown>>(),
  send: vi.fn<(prompt: string) => Promise<unknown>>(),
  close: vi.fn(),
  cancel: vi.fn(async () => {}),
  storeOpen: vi.fn<(options: unknown) => Promise<unknown>>(),
  storeDispose: vi.fn(async () => {}),
  prompt: vi.fn<(prompt: string, options: unknown) => Promise<RunResult>>(async () => ({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
    Agent: { create: cursorSdkMock.create },
    createAgentPlatform: vi.fn(),
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: cursorSdkMock.storeOpen } }),
}));

let hasCustomPolicy = false;
const layerFs = FileSystem.layerNoop({
  exists: () => Effect.succeed(hasCustomPolicy),
  makeTempDirectoryScoped: () => Effect.succeed("/isolated-text-generation"),
});
const layerTest = Layer.merge(layerFs, CursorSdk.layer);

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  hasCustomPolicy = false;
  cursorSdkMock.messages = [];
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.create.mockImplementation(async (options) => {
    cursorSdkMock.send.mockImplementation(async (prompt) => ({
      status: "running",
      cancel: cursorSdkMock.cancel,
      stream: async function* () {
        yield* cursorSdkMock.messages;
      },
      wait: () => cursorSdkMock.prompt(prompt, options),
    }));
    return {
      model: options.model,
      close: cursorSdkMock.close,
      [Symbol.asyncDispose]: async () => {
        cursorSdkMock.close();
      },
      send: cursorSdkMock.send,
    };
  });
  cursorSdkMock.close.mockClear();
  cursorSdkMock.cancel.mockClear();
  cursorSdkMock.storeDispose.mockClear();
  cursorSdkMock.storeOpen.mockReset();
  cursorSdkMock.storeOpen.mockResolvedValue({ dispose: cursorSdkMock.storeDispose });
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

const evaluationInput = {
  cwd: "/isolated-evaluator",
  modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
    { id: "fastMode", value: false },
  ]),
  packet: {
    scope: "turn" as const,
    runOutcome: "completed" as const,
    request: { ref: "U1" as const, text: "Repair the issue." },
    context: [],
    evidence: [{ ref: "E1", kind: "assistant" as const, text: "Fixed." }],
    truncated: false,
    omittedItems: 0,
    missingArtifacts: false,
  },
};
const evaluationVerdict = {
  outcome: "insufficient_evidence",
  taskCategory: "other",
  confidence: "low",
  scores: {
    taskCompletion: null,
    correctness: null,
    instructionFollowing: null,
    verification: null,
  },
  rationale: { text: "No verifiable outcome.", citations: ["E1"] },
  strengths: [],
  weaknesses: [],
  promptAdvice: [],
};
const evaluationResult: RunResult = {
  id: "run-evaluation",
  status: "finished",
  model: { id: "composer-2", params: [{ id: "fast", value: "false" }] },
  result: JSON.stringify(evaluationVerdict),
};

describe("CursorTextGeneration", () => {
  it.effect("evaluates with the selected model, no tools, and no ambient settings", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce(evaluationResult);
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      expect(generation.supportedOperations).toContain("generateModelEvaluation");
      expect(yield* generation.generateModelEvaluation(evaluationInput)).toEqual(evaluationVerdict);
      expect(cursorSdkMock.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          model: evaluationResult.model,
          tools: [],
          local: expect.objectContaining({
            cwd: "/isolated-text-generation",
            settingSources: [],
            sandboxOptions: { enabled: true },
            enableAgentRetries: false,
          }),
        }),
      );
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      expect(cursorSdkMock.storeDispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["auto", "default", ""])(
    "rejects the unpinned judge model %s before starting Cursor",
    (model) =>
      Effect.gen(function* () {
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "key",
        });
        const error = yield* generation
          .generateModelEvaluation({
            ...evaluationInput,
            modelSelection: { ...evaluationInput.modelSelection, model },
          })
          .pipe(Effect.flip);
        expect(error.detail).toContain("explicit model");
        expect(cursorSdkMock.create).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    undefined,
    { id: "different-model" },
    { id: "composer-2", params: [{ id: "fast", value: "true" }] },
    { id: "composer-2" },
  ])("rejects an evaluation without confirmation of the exact model and options (%j)", (model) =>
    Effect.gen(function* () {
      const result = { ...evaluationResult };
      if (model) result.model = model;
      else delete result.model;
      cursorSdkMock.prompt.mockResolvedValueOnce(result);
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const error = yield* generation.generateModelEvaluation(evaluationInput).pipe(Effect.flip);
      expect(error.detail).toContain("selected model and options");
      expect(cursorSdkMock.create).toHaveBeenCalledOnce();
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      type: "tool_call",
      agent_id: "agent-1",
      run_id: "run-1",
      name: "read",
      call_id: "tool-1",
      status: "running",
    },
    {
      type: "assistant",
      agent_id: "agent-1",
      run_id: "run-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
    },
    { type: "request", agent_id: "agent-1", run_id: "run-1", request_id: "request-1" },
    { type: "task", agent_id: "agent-1", run_id: "run-1", status: "running" },
    { type: "system", agent_id: "agent-1", run_id: "run-1", tools: ["read"] },
  ] satisfies SDKMessage[])("rejects forbidden evaluation activity (%j)", (event) =>
    Effect.gen(function* () {
      cursorSdkMock.messages = [event];
      cursorSdkMock.prompt.mockResolvedValueOnce(evaluationResult);
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const error = yield* generation.generateModelEvaluation(evaluationInput).pipe(Effect.flip);
      expect(error.detail).toContain("tool");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
      expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      expect(cursorSdkMock.storeDispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("does not retry a judge without sandboxing", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockRejectedValueOnce(new Error("sandboxing is not supported"));
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const error = yield* generation.generateModelEvaluation(evaluationInput).pipe(Effect.flip);
      expect(error.detail).toContain("could not be created");
      expect(cursorSdkMock.create).toHaveBeenCalledOnce();
      expect(cursorSdkMock.send).not.toHaveBeenCalled();
      expect(cursorSdkMock.storeDispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves the browser credential for every request after an account change", () =>
    Effect.gen(function* () {
      let apiKey = "first-browser-key";
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        {},
        Effect.sync(() => apiKey),
      );
      const input = {
        cwd: process.cwd(),
        branch: "feature/cursor",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
      };
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "first-browser-key" }),
      );
      apiKey = "second-browser-key";
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "second-browser-key" }),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("continues in the temp directory when the SDK cannot sandbox", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockImplementationOnce(async () => {
        throw new Error(
          "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
        );
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch: "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2"),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(cursorSdkMock.create).toHaveBeenCalledTimes(2);
      expect(cursorSdkMock.create.mock.calls[0]?.[0]).toMatchObject({
        local: { sandboxOptions: { enabled: true } },
      });
      expect(cursorSdkMock.create.mock.calls[1]?.[0]).toMatchObject({
        local: {
          cwd: "/isolated-text-generation",
          store: { dispose: cursorSdkMock.storeDispose },
          autoReview: false,
          sandboxOptions: { enabled: false },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      status: "error",
      error: { message: "Raw Cursor usage text", code: "PRO_USER_USAGE_LIMIT" },
      detail:
        "Cursor usage limit reached. Try again later or choose another text-generation provider.",
    },
    {
      status: "error",
      error: { message: "Raw Cursor backend text", code: "internal" },
      detail: "Cursor SDK request finished with an error.",
    },
    { status: "cancelled", error: undefined, detail: "Cursor SDK request was cancelled." },
  ] as const)(
    "rejects a $status Cursor SDK run ($error.code) that includes valid title JSON",
    ({ status, error, detail }) =>
      Effect.gen(function* () {
        const promptResult = {
          id: "run-cursor-partial-title-test",
          status,
          result: '{"title":"Partial title from a failed run."}',
          ...(error ? { error } : {}),
        } satisfies RunResult;
        cursorSdkMock.prompt.mockResolvedValueOnce(promptResult);
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "test-cursor-key",
        });
        const failure = yield* Effect.flip(
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          }),
        );
        expect(failure).toBeInstanceOf(TextGenerationError);
        expect(failure.operation).toBe("generateThreadTitle");
        expect(failure.detail).toBe(detail);
        expect(failure.message).not.toContain("Raw Cursor");
        expect(failure.cause).toBe(error);
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails closed when ambient sandbox policy can expand write access", () =>
    Effect.gen(function* () {
      hasCustomPolicy = true;
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(
        generation.generateThreadTitle({
          cwd: "/real-workspace",
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(failure.detail).toContain("custom ~/.cursor/sandbox.json");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Sign in with Cursor or add CURSOR_API_KEY in provider settings.");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );
});
