import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
} from "../Errors.ts";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  type ProviderKind,
  ProviderTurnStartResult,
  TurnId,
  ThreadId,
  RuntimeItemId,
  ProviderItemId,
} from "@t3tools/contracts";
import { Effect, Layer, Stream, Queue, ServiceMap } from "effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ServerConfig } from "../../config.ts";

export interface ClaudeCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeCode";
}

export class ClaudeCodeAdapterService extends ServiceMap.Service<
  ClaudeCodeAdapterService,
  ClaudeCodeAdapterShape
>()("t3/provider/Layers/ClaudeCodeAdapter/ClaudeCodeAdapterService") {}

interface ClaudeSessionInfo {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export const ClaudeCodeAdapterLive = Layer.effect(
  ClaudeCodeAdapterService,
  Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const activeSessions = new Map<string, ClaudeSessionInfo>();

    const adapter: ClaudeCodeAdapterShape = {
      provider: "claudeCode",
      capabilities: {
        sessionModelSwitch: "restart-session",
      },
      startSession: (input) =>
        Effect.sync(() => {
          activeSessions.set(input.threadId, {
            apiKey: input.providerOptions?.claudeCode?.apiKey,
            baseUrl: input.providerOptions?.claudeCode?.baseUrl,
          });

          return {
            provider: "claudeCode",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            status: "ready",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const turnId = TurnId.makeUnsafe(randomUUID());
          const sessionInfo = activeSessions.get(input.threadId);

          let anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
          let anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "";

          if (sessionInfo?.apiKey) {
            anthropicApiKey = sessionInfo.apiKey;
          }
          if (sessionInfo?.baseUrl) {
            anthropicBaseUrl = sessionInfo.baseUrl;
          }

          const args = [
            "-p",
            "--input-format=stream-json",
            "--output-format=stream-json",
          ];
          if (input.model && input.model !== "claude-4-6-sonnet-20260217") {
            args.push("--model", input.model);
          }

          const env = { ...process.env };
          if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;
          if (anthropicBaseUrl) env.ANTHROPIC_BASE_URL = anthropicBaseUrl;

          const child = spawn("claude", args, { env });
          const itemId = ProviderItemId.makeUnsafe(randomUUID());

          child.stdin.write(
            JSON.stringify({ prompt: input.input || "" }) + "\n",
          );
          child.stdin.end();

          const rl = readline.createInterface({ input: child.stdout });

          rl.on("line", (line) => {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "assistant" && parsed.message?.content) {
                const text = parsed.message.content.find(
                  (c: any) => c.type === "text",
                )?.text;
                if (text) {
                  Queue.offer(eventQueue, {
                    type: "content.delta",
                    eventId: randomUUID() as any,
                    provider: "claudeCode",
                    createdAt: new Date().toISOString(),
                    threadId: input.threadId,
                    turnId,
                    itemId: itemId as any as RuntimeItemId,
                    payload: { streamKind: "assistant_text", delta: text },
                  } as ProviderRuntimeEvent).pipe(Effect.runFork);
                }
              } else if (parsed.type === "result") {
                Queue.offer(eventQueue, {
                  type: "item.completed",
                  eventId: randomUUID() as any,
                  provider: "claudeCode",
                  createdAt: new Date().toISOString(),
                  threadId: input.threadId,
                  turnId,
                  itemId: itemId as any as RuntimeItemId,
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                  },
                } as ProviderRuntimeEvent).pipe(Effect.runFork);

                Queue.offer(eventQueue, {
                  type: "turn.completed",
                  eventId: randomUUID() as any,
                  provider: "claudeCode",
                  createdAt: new Date().toISOString(),
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "completed" },
                } as unknown as ProviderRuntimeEvent).pipe(Effect.runFork);
              }
            } catch (e) {
              // ignore parse errors
            }
          });

          child.on("error", (error) => {
            Queue.offer(eventQueue, {
              type: "runtime.error",
              eventId: randomUUID() as any,
              provider: "claudeCode",
              createdAt: new Date().toISOString(),
              threadId: input.threadId,
              turnId,
              payload: { message: error.message },
            } as ProviderRuntimeEvent).pipe(Effect.runFork);
          });

          const result: ProviderTurnStartResult = {
            threadId: input.threadId,
            turnId,
          };
          return result;
        }),
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession: (threadId) =>
        Effect.sync(() => {
          activeSessions.delete(threadId);
        }),
      listSessions: () => Effect.succeed([]),
      hasSession: (threadId) => Effect.sync(() => activeSessions.has(threadId)),
      readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      stopAll: () =>
        Effect.sync(() => {
          activeSessions.clear();
        }),
      streamEvents: Stream.fromQueue(eventQueue),
    };

    return adapter;
  }),
);
