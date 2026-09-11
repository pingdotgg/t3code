import type { RunResult } from "@cursor/sdk";
import { CursorSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";

const cursorSdkMock = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => Promise<unknown>>(),
  send: vi.fn<(prompt: string) => Promise<unknown>>(),
  close: vi.fn(),
  cancel: vi.fn(async () => {}),
  prompt: vi.fn<(prompt: string, options: unknown) => Promise<RunResult>>(async () => ({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("@cursor/sdk", () => ({ Agent: { create: cursorSdkMock.create } }));

let hasCustomPolicy = false;
const fsLayer = FileSystem.layerNoop({
  exists: () => Effect.succeed(hasCustomPolicy),
  makeTempDirectoryScoped: () => Effect.succeed("/isolated-text-generation"),
});

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  hasCustomPolicy = false;
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.create.mockImplementation(async (options) => {
    cursorSdkMock.send.mockImplementation(async (prompt) => ({
      status: "running",
      cancel: cursorSdkMock.cancel,
      wait: () => cursorSdkMock.prompt(prompt, options),
    }));
    return {
      close: cursorSdkMock.close,
      [Symbol.asyncDispose]: async () => {
        cursorSdkMock.close();
      },
      send: cursorSdkMock.send,
    };
  });
  cursorSdkMock.close.mockClear();
  cursorSdkMock.cancel.mockClear();
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

describe("CursorTextGeneration", () => {
  it.effect("uses the Cursor SDK prompt API with model parameters and API key", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor sdk text generation");

      expect(cursorSdkMock.prompt).toHaveBeenCalledTimes(1);
      const [prompt, options] = (
        cursorSdkMock.prompt.mock.calls as unknown as Array<[string, unknown]>
      )[0]!;
      expect(prompt).toContain("Staged patch:");
      expect(options).toEqual({
        apiKey: "test-cursor-key",
        mode: "plan",
        model: {
          id: "gpt-5.4",
          params: [
            { id: "thinking", value: "high" },
            { id: "context", value: "1m" },
            { id: "fast", value: "true" },
          ],
        },
        local: {
          cwd: "/isolated-text-generation",
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(fsLayer)),
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
    }).pipe(Effect.provide(fsLayer)),
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
    }).pipe(Effect.provide(fsLayer)),
  );

  for (const status of ["error", "cancelled"] as const) {
    it.effect(`rejects a ${status} Cursor SDK run that includes valid title JSON`, () =>
      Effect.gen(function* () {
        const promptResult = {
          id: "run-cursor-partial-title-test",
          status,
          result: '{"title":"Partial title from a failed run."}',
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
        expect(failure._tag).toBe("TextGenerationError");
        expect(failure).toBeInstanceOf(TextGenerationError);
        expect(failure.operation).toBe("generateThreadTitle");
        expect(failure.detail).toBe(
          status === "cancelled"
            ? "Cursor SDK request was cancelled."
            : "Cursor SDK request finished with an error.",
        );
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(fsLayer)),
    );
  }

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
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("cancels the native run when text generation times out", () =>
    Effect.gen(function* () {
      let started!: () => void;
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      cursorSdkMock.prompt.mockImplementationOnce(() => {
        started();
        return new Promise(() => {});
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const result = yield* generation
        .generateThreadTitle({
          cwd: "/real-workspace",
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => called);
      yield* TestClock.adjust("180 seconds");
      expect((yield* Fiber.join(result)).detail).toContain("timed out");
      expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(fsLayer), Effect.scoped),
  );

  for (const phase of ["create", "send"] as const) {
    it.effect(`times out pending ${phase} and releases its late SDK resource`, () =>
      Effect.gen(function* () {
        let started!: () => void;
        const called = new Promise<void>((resolve) => {
          started = resolve;
        });
        let resolveLate!: (resource: unknown) => void;
        const pending = new Promise<unknown>((resolve) => {
          resolveLate = resolve;
        });
        const wait = vi.fn();
        const agent = {
          close: cursorSdkMock.close,
          [Symbol.asyncDispose]: async () => {
            cursorSdkMock.close();
          },
          send: async () => {
            started();
            return pending;
          },
        };
        cursorSdkMock.create.mockImplementation(async () => {
          if (phase === "create") {
            started();
            return pending;
          }
          return agent;
        });
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "key",
        });
        const result = yield* generation
          .generateThreadTitle({
            cwd: "/real-workspace",
            message: "Title",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => called);
        yield* TestClock.adjust("180 seconds");
        expect((yield* Fiber.join(result)).detail).toContain("timed out");
        let cleanup!: () => void;
        const cleaned = new Promise<void>((resolve) => {
          cleanup = resolve;
        });
        if (phase === "create") cursorSdkMock.close.mockImplementationOnce(cleanup);
        else
          cursorSdkMock.cancel.mockImplementationOnce(async () => {
            cleanup();
          });
        resolveLate(
          phase === "create" ? agent : { status: "running", cancel: cursorSdkMock.cancel, wait },
        );
        yield* Effect.promise(() => cleaned);
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
        expect(wait).not.toHaveBeenCalled();
        if (phase === "send") expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(fsLayer), Effect.scoped),
    );
  }

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

      expect(error.detail).toBe(
        "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
      );
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(fsLayer)),
  );
});
