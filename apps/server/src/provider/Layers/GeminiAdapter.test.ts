import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderRuntimeEvent, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { Effect, Layer, Ref, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  accumulateGeminiPromptUsage,
  buildGeminiPromptUsageSnapshot,
  buildGeminiThinkingModelConfigAliases,
  makeGeminiAdapterLive,
  normalizeGeminiPromptUsage,
  resolveRequestedGeminiModeId,
} from "./GeminiAdapter.ts";

const tempDirs: Array<string> = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeGeminiBinary(): {
  readonly baseDir: string;
  readonly binaryPath: string;
  readonly cwd: string;
} {
  const baseDir = makeTempDir("gemini-adapter-test-");
  const binaryPath = path.join(baseDir, "fake-gemini-acp.js");

  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const readline = require("node:readline");

let sessionCounter = 0;
let currentModeId = "yolo";
let currentSessionId = "session-" + process.pid + "-0";
let pendingPrompt = null;

const reply = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};

const notify = (method, params) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const message = JSON.parse(trimmed);

  switch (message.method) {
    case "initialize":
      reply(message.id, { protocolVersion: 1 });
      return;
    case "session/new":
      sessionCounter += 1;
      currentSessionId = "session-" + process.pid + "-" + sessionCounter;
      reply(message.id, {
        sessionId: currentSessionId,
      });
      return;
    case "session/set_mode":
      if (message.params && typeof message.params.modeId === "string") {
        currentModeId = message.params.modeId;
      }
      reply(message.id, {});
      return;
    case "session/set_model":
      reply(message.id, {});
      return;
    case "session/prompt": {
      const sessionId =
        message.params && typeof message.params.sessionId === "string"
          ? message.params.sessionId
          : currentSessionId;
      const promptBlocks = Array.isArray(message.params?.prompt) ? message.params.prompt : [];
      const promptText = promptBlocks
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\\n");
      if (promptText.includes("wait for interrupt")) {
        pendingPrompt = {
          id: message.id,
          sessionId,
        };
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "still working..." },
          },
        });
        return;
      }
      if (currentModeId === "plan") {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Inspect the existing implementation",
                priority: "high",
                status: "completed",
              },
              {
                content: "Ship the requested change",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "# Gemini plan\\n\\n- inspect the existing implementation\\n- ship the requested change",
            },
          },
        });
      } else {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from fake gemini" },
          },
        });
      }
      reply(message.id, { stopReason: "end_turn" });
      return;
    }
    case "session/cancel":
      return;
    default:
      reply(message.id, {});
  }
});

process.on("SIGTERM", () => {
  pendingPrompt = null;
  setTimeout(() => process.exit(1), 75);
});
`,
    "utf8",
  );
  chmodSync(binaryPath, 0o755);

  return {
    baseDir,
    binaryPath,
    cwd: baseDir,
  };
}

function makeProviderRegistryLayer(providers: ReadonlyArray<ServerProvider> = []) {
  return Layer.succeed(ProviderRegistry, {
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    streamChanges: Stream.empty,
  });
}

function makeHarness() {
  const fakeBinary = writeFakeGeminiBinary();

  return makeGeminiAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(fakeBinary.cwd, fakeBinary.baseDir)),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          gemini: {
            binaryPath: fakeBinary.binaryPath,
          },
        },
      }),
    ),
    Layer.provideMerge(makeProviderRegistryLayer()),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("buildGeminiThinkingModelConfigAliases", () => {
  it("builds Gemini 3 and Gemini 2.5 aliases from model families", () => {
    expect(
      buildGeminiThinkingModelConfigAliases(["auto-gemini-3", "gemini-2.5-flash", "custom-model"]),
    ).toMatchObject({
      "t3code-gemini-auto-gemini-3-thinking-level-high": {
        extends: "chat-base-3",
        modelConfig: {
          model: "auto-gemini-3",
          generateContentConfig: {
            thinkingConfig: {
              thinkingLevel: "HIGH",
            },
          },
        },
      },
      "t3code-gemini-auto-gemini-3-thinking-level-low": {
        extends: "chat-base-3",
        modelConfig: {
          model: "auto-gemini-3",
          generateContentConfig: {
            thinkingConfig: {
              thinkingLevel: "LOW",
            },
          },
        },
      },
      "t3code-gemini-gemini-2-5-flash-thinking-budget-dynamic": {
        extends: "chat-base-2.5",
        modelConfig: {
          model: "gemini-2.5-flash",
          generateContentConfig: {
            thinkingConfig: {
              thinkingBudget: -1,
            },
          },
        },
      },
      "t3code-gemini-gemini-2-5-flash-thinking-budget-512": {
        extends: "chat-base-2.5",
        modelConfig: {
          model: "gemini-2.5-flash",
          generateContentConfig: {
            thinkingConfig: {
              thinkingBudget: 512,
            },
          },
        },
      },
    });
  });
});

describe("GeminiAdapterLive", () => {
  it("accumulates Gemini prompt usage into cumulative and per-turn snapshots", () => {
    const firstTurn = normalizeGeminiPromptUsage({
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
    });
    assert.ok(firstTurn);

    const firstCumulative = accumulateGeminiPromptUsage(undefined, firstTurn);
    expect(buildGeminiPromptUsageSnapshot(undefined, firstCumulative, firstTurn)).toEqual({
      usedTokens: 120,
      totalProcessedTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      lastUsedTokens: 120,
      lastInputTokens: 80,
      lastOutputTokens: 40,
    });

    const secondTurn = normalizeGeminiPromptUsage({
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
    });
    assert.ok(secondTurn);

    const secondCumulative = accumulateGeminiPromptUsage(firstCumulative, secondTurn);
    expect(buildGeminiPromptUsageSnapshot(undefined, secondCumulative, secondTurn)).toEqual({
      usedTokens: 150,
      totalProcessedTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      lastUsedTokens: 30,
      lastInputTokens: 20,
      lastOutputTokens: 10,
    });

    expect(
      buildGeminiPromptUsageSnapshot(
        {
          usedTokens: 2_048,
          totalProcessedTokens: 120,
          maxTokens: 1_000_000,
        },
        secondCumulative,
        secondTurn,
      ),
    ).toEqual({
      usedTokens: 2_048,
      totalProcessedTokens: 150,
      maxTokens: 1_000_000,
      inputTokens: 100,
      outputTokens: 50,
      lastUsedTokens: 30,
      lastInputTokens: 20,
      lastOutputTokens: 10,
    });
  });

  it("does not emit stale exit events when startSession replaces an existing session", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* GeminiAdapter;
          const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);

          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Ref.update(eventsRef, (events) => [...events, event]),
          ).pipe(Effect.forkScoped);

          const threadId = ThreadId.make("thread-gemini-stale-exit");

          yield* adapter.startSession({
            provider: "gemini",
            threadId,
            runtimeMode: "full-access",
          });
          yield* adapter.startSession({
            provider: "gemini",
            threadId,
            runtimeMode: "full-access",
          });

          yield* Effect.sleep("250 millis");

          const events = yield* Ref.get(eventsRef);
          assert.equal(
            events.some((event) => event.type === "runtime.error"),
            false,
            "replaced sessions should not emit stale runtime.error events",
          );
          assert.equal(
            events.some((event) => event.type === "session.exited"),
            false,
            "replaced sessions should not emit stale session.exited events",
          );
        }).pipe(Effect.provide(makeHarness())),
      ),
    );
  });

  it("captures Gemini plan turns as proposed plans for follow-up actions", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* GeminiAdapter;
          const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);

          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Ref.update(eventsRef, (events) => [...events, event]),
          ).pipe(Effect.forkScoped);

          const threadId = ThreadId.make("thread-gemini-plan");
          yield* adapter.startSession({
            provider: "gemini",
            threadId,
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({
            threadId,
            input: "plan this change",
            interactionMode: "plan",
            attachments: [],
          });

          for (let remainingAttempts = 50; remainingAttempts > 0; remainingAttempts -= 1) {
            const events = yield* Ref.get(eventsRef);
            if (
              events.some((event) => event.type === "turn.proposed.completed") &&
              events.some((event) => event.type === "turn.completed")
            ) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }

          const events = yield* Ref.get(eventsRef);
          const proposedEvent = events.find((event) => event.type === "turn.proposed.completed");
          expect(proposedEvent).toBeDefined();
          if (proposedEvent?.type !== "turn.proposed.completed") {
            return;
          }

          expect(proposedEvent.payload.planMarkdown).toBe(
            "# Gemini plan\n\n- inspect the existing implementation\n- ship the requested change",
          );
        }).pipe(Effect.provide(makeHarness())),
      ),
    );
  });

  it("falls back to interrupting the turn locally when Gemini ignores session/cancel", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* GeminiAdapter;
          const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);

          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Ref.update(eventsRef, (events) => [...events, event]),
          ).pipe(Effect.forkScoped);

          const threadId = ThreadId.make("thread-gemini-unsupported-cancel");
          yield* adapter.startSession({
            provider: "gemini",
            threadId,
            runtimeMode: "full-access",
          });

          const started = yield* adapter.sendTurn({
            threadId,
            input: "wait for interrupt",
            attachments: [],
          });

          for (let remainingAttempts = 50; remainingAttempts > 0; remainingAttempts -= 1) {
            const events = yield* Ref.get(eventsRef);
            if (
              events.some(
                (event) =>
                  event.type === "content.delta" &&
                  event.turnId === started.turnId &&
                  event.payload.delta === "still working...",
              )
            ) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }

          yield* adapter.interruptTurn(threadId, started.turnId);

          for (let remainingAttempts = 100; remainingAttempts > 0; remainingAttempts -= 1) {
            const events = yield* Ref.get(eventsRef);
            if (
              events.some(
                (event) =>
                  event.type === "turn.completed" &&
                  event.turnId === started.turnId &&
                  event.payload.state === "interrupted",
              ) &&
              events.some((event) => event.type === "session.exited")
            ) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }

          const events = yield* Ref.get(eventsRef);
          expect(
            events.some(
              (event) =>
                event.type === "turn.completed" &&
                event.turnId === started.turnId &&
                event.payload.state === "interrupted" &&
                event.payload.stopReason === "cancelled",
            ),
          ).toBe(true);
          expect(events.some((event) => event.type === "session.exited")).toBe(true);
          expect(events.some((event) => event.type === "runtime.error")).toBe(false);
        }).pipe(Effect.provide(makeHarness())),
      ),
    );
  });

  it("restores the runtime-backed Gemini mode after leaving plan mode", () => {
    expect(
      resolveRequestedGeminiModeId({
        interactionMode: "default",
        runtimeModeId: "default",
        currentModeId: "plan",
      }),
    ).toBe("default");
    expect(
      resolveRequestedGeminiModeId({
        interactionMode: "default",
        runtimeModeId: "auto_edit",
        currentModeId: "plan",
      }),
    ).toBe("auto_edit");
    expect(
      resolveRequestedGeminiModeId({
        interactionMode: "default",
        runtimeModeId: "yolo",
        currentModeId: "plan",
      }),
    ).toBe("yolo");
  });

  it("leaves the current Gemini mode unchanged when interaction mode is omitted", () => {
    expect(
      resolveRequestedGeminiModeId({
        interactionMode: undefined,
        runtimeModeId: "yolo",
        currentModeId: "plan",
      }),
    ).toBe("plan");
  });
});
