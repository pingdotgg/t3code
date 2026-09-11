import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { NotificationHandler } from "@muse-code/sdk";
import {
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  MuseSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import type { MuseSdkHost } from "../provider/museSdk.ts";
import { museModelCapabilities } from "../provider/museModelCatalog.ts";
import { makeMuseTextGeneration } from "./MuseTextGeneration.ts";

const settings = Schema.decodeSync(MuseSettings)({ enabled: true });
const modelSelection = createModelSelection(
  ProviderInstanceId.make("muse"),
  "muse-spark-1.3-contributor",
  [{ id: "reasoningEffort", value: "high" }],
);
const titleInput = {
  cwd: "/project/should-not-be-used",
  message: "Fix the login form",
  modelSelection,
};

function fixture(
  onTurn?: (emit: (method: string, params: Record<string, unknown>) => void) => void,
  acknowledgeTurn = true,
  modelCatalog?: Parameters<typeof makeMuseTextGeneration>[3],
) {
  let handler: NotificationHandler = () => {};
  let commandSequence = 0;
  let activeTurnId: string | undefined;
  const mintCommandId = () => `turn-${++commandSequence}`;
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const emit = (method: string, params: Record<string, unknown>) =>
    handler({
      jsonrpc: "2.0",
      method,
      params: {
        sessionId: "session-1",
        turnId: activeTurnId,
        ...params,
        ...(params.item
          ? {
              item: {
                revision: 1,
                turnId: activeTurnId,
                ...(params.item as Record<string, unknown>),
              },
            }
          : {}),
      },
    });
  const host: MuseSdkHost = {
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome: "/fake/muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { fingerprint: "test", version: 1 },
      serverInfo: { name: "muse", version: "1.1.1" },
      userAgent: "test",
    },
    connection: {
      command: vi.fn(async (method, _params, options) => {
        // Connection.command overwrites params.commandId unless supplied in options.
        const commandId = options?.commandId ?? mintCommandId();
        if (method === "session/start") return { session: { sessionId: "session-1" } };
        if (method === "turn/start") {
          activeTurnId = commandId;
          started.resolve();
          onTurn?.(emit);
          if (!acknowledgeTurn) return await new Promise<Record<string, unknown>>(() => {});
          return { turnId: commandId };
        }
        return {};
      }),
      request: vi.fn(async () => ({})),
      mintCommandId,
      onNotification: (nextHandler) => {
        handler = nextHandler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed: closed.promise,
    },
    close: vi.fn(async () => {
      closed.resolve();
    }),
    exited: new Promise(() => {}),
  };
  const createHost = vi.fn(async () => host);
  const make = makeMuseTextGeneration(settings, undefined, createHost, modelCatalog);
  return {
    host,
    createHost,
    started: started.promise,
    closeConnection: closed.resolve,
    emit,
    make,
  };
}

const finish =
  (text: string) => (emit: (method: string, params: Record<string, unknown>) => void) => {
    emit("item/updated", { item: { itemId: "answer", kind: "agentMessage", text: "partial" } });
    emit("item/completed", {
      item: { itemId: "answer", kind: "agentMessage", revision: 2, text },
    });
    emit("turn/completed", { terminal: "completed" });
  };

it.layer(NodeServices.layer)("Muse text generation", (it) => {
  it.effect("rejects unsupported effort before starting a host", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.make;
      const error = yield* service
        .generateThreadTitle({
          ...titleInput,
          modelSelection: createModelSelection(
            ProviderInstanceId.make("muse"),
            modelSelection.model,
            [{ id: "reasoningEffort", value: "invalid-effort" }],
          ),
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("does not support reasoning effort 'invalid-effort'");
      expect(test.createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("validates the final item once and closes an isolated restrictive host", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"title":"Fix login form"}'));
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput)).toEqual({
        title: "Fix login form",
      });
      expect(test.createHost).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true, sessionLogging: true }),
      );
      expect(test.createHost).not.toHaveBeenCalledWith(
        expect.objectContaining({ cwd: titleInput.cwd }),
      );
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "session/start",
        expect.objectContaining({
          providerId: "meta",
          modelId: modelSelection.model,
          approvalMode: "denyUnmatched",
        }),
      );
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({
          reasoningEffort: "high",
        }),
        { commandId: "turn-1" },
      );
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("forwards max effort unchanged for Muse Spark 1.3 text generation", () =>
    Effect.gen(function* () {
      const test = fixture(
        finish('{"title":"Fix login form"}'),
        true,
        Effect.succeed([
          {
            slug: "muse-spark-1.3",
            name: "Muse Spark 1.3",
            isCustom: false,
            capabilities: museModelCapabilities("muse-spark-1.3"),
          },
        ]),
      );
      const service = yield* test.make;
      expect(
        yield* service.generateThreadTitle({
          ...titleInput,
          modelSelection: createModelSelection(ProviderInstanceId.make("muse"), "muse-spark-1.3", [
            { id: "reasoningEffort", value: "max" },
          ]),
        }),
      ).toEqual({ title: "Fix login form" });
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "session/start",
        expect.objectContaining({ modelId: "muse-spark-1.3" }),
      );
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ reasoningEffort: "max" }),
        { commandId: "turn-1" },
      );
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("normalizes stale settings and the metadata default against model capabilities", () =>
    Effect.gen(function* () {
      for (const { saved, tiers, expected } of [
        { saved: "ultra", tiers: ["medium", "xhigh"], expected: "medium" },
        { saved: "max", tiers: ["medium", "xhigh"], expected: "medium" },
        { saved: undefined, tiers: ["xhigh", "max"], expected: "xhigh" },
        { saved: "high", tiers: [], expected: undefined },
      ]) {
        const test = fixture(
          finish('{"title":"Fix login form"}'),
          true,
          Effect.succeed([
            {
              slug: modelSelection.model,
              name: modelSelection.model,
              isCustom: false,
              capabilities: museModelCapabilities(
                modelSelection.model,
                tiers.map((tier) => ({ tier })),
              ),
            },
          ]),
        );
        const service = yield* test.make;
        expect(
          yield* service.generateThreadTitle({
            ...titleInput,
            modelSelection: createModelSelection(
              ProviderInstanceId.make("muse"),
              modelSelection.model,
              saved !== undefined ? [{ id: "reasoningEffort", value: saved }] : undefined,
            ),
          }),
        ).toEqual({ title: "Fix login form" });
        const turn = vi
          .mocked(test.host.connection.command)
          .mock.calls.find(([method]) => method === "turn/start");
        expect(turn?.[1].reasoningEffort).toBe(expected);
        expect(Object.hasOwn(turn?.[1] ?? {}, "reasoningEffort")).toBe(expected !== undefined);
        expect(test.host.close).toHaveBeenCalledOnce();
      }
    }),
  );

  it.effect(
    "accepts the SDK's none, minimal, and ultra efforts without replacing the selection",
    () =>
      Effect.gen(function* () {
        for (const reasoningEffort of ["none", "minimal", "ultra"]) {
          const test = fixture(finish('{"title":"Fix login form"}'));
          const service = yield* test.make;
          expect(
            yield* service.generateThreadTitle({
              ...titleInput,
              modelSelection: createModelSelection(
                ProviderInstanceId.make("muse"),
                modelSelection.model,
                [{ id: "reasoningEffort", value: reasoningEffort }],
              ),
            }),
          ).toEqual({ title: "Fix login form" });
          expect(test.host.connection.command).toHaveBeenCalledWith(
            "turn/start",
            expect.objectContaining({ reasoningEffort }),
            { commandId: "turn-1" },
          );
        }
      }),
  );

  it.effect("rejects invalid structured output and releases the host", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"title":42}'));
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
        detail: "Muse returned invalid structured output.",
      });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("uses the shared metadata effort when the selection has no override", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"title":"Fix login form"}'));
      const service = yield* test.make;
      yield* service.generateThreadTitle({
        ...titleInput,
        modelSelection: createModelSelection(ProviderInstanceId.make("muse"), modelSelection.model),
      });
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ reasoningEffort: DEFAULT_TEXT_GENERATION_REASONING_EFFORT }),
        { commandId: "turn-1" },
      );
    }),
  );

  it.effect("uses the final assistant answer and accepts fenced JSON like other providers", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("item/completed", {
          item: { itemId: "commentary", kind: "agentMessage", text: "I will write a title." },
        });
        finish('```json\n{"title":"Fix login form"}\n```')(emit);
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput)).toEqual({ title: "Fix login form" });
    }),
  );

  it.effect("ignores stale snapshots and retracted answers", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("item/completed", {
          item: {
            itemId: "answer",
            kind: "agentMessage",
            revision: 2,
            text: '{"title":"Fix login form"}',
          },
        });
        emit("item/updated", {
          item: { itemId: "answer", kind: "agentMessage", text: "stale partial text" },
        });
        emit("item/completed", {
          item: { itemId: "withdrawn", kind: "agentMessage", text: "Withdrawn answer" },
        });
        emit("item/updated", {
          item: { itemId: "withdrawn", kind: "agentMessage", revision: 2, retracted: true },
        });
        emit("turn/completed", { terminal: "completed" });
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput)).toEqual({ title: "Fix login form" });
    }),
  );

  it.effect("ignores output and terminal notifications for another turn", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("item/completed", {
          item: {
            itemId: "other-answer",
            kind: "agentMessage",
            turnId: "another-turn",
            text: '{"title":"Wrong title"}',
          },
        });
        emit("turn/completed", { turnId: "another-turn", terminal: "completed" });
        finish('{"title":"Fix login form"}')(emit);
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput)).toEqual({ title: "Fix login form" });
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ sessionId: "session-1" }),
        { commandId: "turn-1" },
      );
    }),
  );

  it.effect("rejects a truncated response even when its prefix contains valid JSON", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("item/completed", {
          item: {
            itemId: "answer",
            kind: "agentMessage",
            text: '{"title":"Incomplete answer"}',
            truncated: true,
          },
        });
        emit("turn/completed", { terminal: "completed" });
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("settles a completed turn even when its start acknowledgement never arrives", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"title":"Fix login form"}'), false);
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput)).toEqual({ title: "Fix login form" });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reports a failed turn without trying another provider", () =>
    Effect.gen(function* () {
      const test = fixture((emit) =>
        emit("turn/completed", {
          terminal: "failed",
          error: { message: "Authentication required. Run muse login." },
        }),
      );
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.createHost).toHaveBeenCalledOnce();
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("does not accept assistant output before a later failed terminal event", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("item/completed", {
          item: { itemId: "answer", kind: "agentMessage", text: '{"title":"Fix login"}' },
        });
        emit("turn/completed", {
          terminal: "failed",
          error: { message: "Turn failed after producing an answer." },
        });
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("settles when the transport closes before completion", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.make;
      const pending = yield* service
        .generateThreadTitle(titleInput)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => test.started);
      test.closeConnection();
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "TextGenerationError" });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("releases the host when interrupted after the turn starts", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.make;
      const fiber = yield* service.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => test.started);
      yield* Fiber.interrupt(fiber);
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("forwards interruption while the SDK host is still starting", () =>
    Effect.gen(function* () {
      const starting = Promise.withResolvers<AbortSignal>();
      const service = yield* makeMuseTextGeneration(settings, undefined, (options) => {
        const signal = options.signal!;
        starting.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const fiber = yield* service.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => starting.promise);
      yield* Fiber.interrupt(fiber);
      expect(signal.aborted).toBe(true);
    }),
  );

  it.effect("denies approval requests and fails the noninteractive request", () =>
    Effect.gen(function* () {
      const test = fixture((emit) =>
        emit("approval/requested", {
          approvalId: "approval-1",
          currentRequirementId: "requirement-1",
          availableChoices: [{ choiceId: "deny-1", decision: "denied" }],
        }),
      );
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.host.connection.command).toHaveBeenCalledWith("approval/decide", {
        sessionId: "session-1",
        approvalId: "approval-1",
        requirementId: "requirement-1",
        choiceId: "deny-1",
      });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("cancels user input requests", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => emit("userInput/requested", { userInputId: "input-1" }));
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.host.connection.command).toHaveBeenCalledWith(
        "userInput/cancel",
        expect.objectContaining({
          userInputId: "input-1",
        }),
      );
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("rejects interactive requests before a successful terminal event can win", () =>
    Effect.gen(function* () {
      const test = fixture((emit) => {
        emit("userInput/requested", { userInputId: "input-1" });
        finish('{"title":"Unexpected success"}')(emit);
      });
      const service = yield* test.make;
      expect(yield* service.generateThreadTitle(titleInput).pipe(Effect.flip)).toMatchObject({
        _tag: "TextGenerationError",
      });
      expect(test.host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("generates and sanitizes commit content through Muse", () =>
    Effect.gen(function* () {
      const test = fixture(
        finish('{"subject":"Fix login.","body":" Details ","branch":"fix-login"}'),
      );
      const service = yield* test.make;
      const generated = yield* service.generateCommitMessage({
        cwd: titleInput.cwd,
        branch: "main",
        stagedSummary: "login.ts",
        stagedPatch: "login change",
        includeBranch: true,
        modelSelection,
      });
      expect(generated.subject).toBe("Fix login");
      expect(generated.body).toBe("Details");
      expect(generated.branch).toContain("fix-login");
    }),
  );

  it.effect("generates PR content through Muse", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"title":"Fix login","body":" Changes "}'));
      const service = yield* test.make;
      expect(
        yield* service.generatePrContent({
          cwd: titleInput.cwd,
          baseBranch: "main",
          headBranch: "fix-login",
          commitSummary: "Fix login",
          diffSummary: "login.ts",
          diffPatch: "patch",
          modelSelection,
        }),
      ).toEqual({ title: "Fix login", body: "Changes" });
    }),
  );

  it.effect("generates branch names through Muse", () =>
    Effect.gen(function* () {
      const test = fixture(finish('{"branch":"Fix Login Form"}'));
      const service = yield* test.make;
      expect(yield* service.generateBranchName(titleInput)).toEqual({
        branch: "fix-login-form",
      });
    }),
  );
});
