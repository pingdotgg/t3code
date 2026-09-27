import * as NodeAssert from "node:assert/strict";

import type { Event as LegacyEvent } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OpenCodeNextClient } from "./opencodeRuntime.ts";
import { createOpenCodeCompatClient } from "./opencodeNextClient.ts";

interface PromptCalls {
  readonly switchedModels: Array<unknown>;
  readonly switchedAgents: Array<unknown>;
  readonly instructions: Array<unknown>;
  readonly prompts: Array<unknown>;
}

function makeRuntime(events: ReadonlyArray<unknown>) {
  const calls: PromptCalls = {
    switchedModels: [],
    switchedAgents: [],
    instructions: [],
    prompts: [],
  };
  const client = {
    server: { info: async () => ({ version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/t" } }) },
    session: {
      switchModel: async (input: unknown) => {
        calls.switchedModels.push(input);
      },
      switchAgent: async (input: unknown) => {
        calls.switchedAgents.push(input);
      },
      instructions: {
        entry: {
          put: async (input: unknown) => {
            calls.instructions.push(input);
          },
        },
      },
      prompt: async (input: unknown) => {
        calls.prompts.push(input);
        return { id: "ses_1" };
      },
    },
    event: {
      subscribe: async function* () {
        for (const event of events) yield event;
      },
    },
  } as unknown as OpenCodeNextClient;
  return { client, calls };
}

async function collectEvents(
  stream: AsyncIterable<LegacyEvent>,
  limit: number,
): Promise<Array<LegacyEvent>> {
  const collected: Array<LegacyEvent> = [];
  for await (const event of stream) {
    collected.push(event);
    if (collected.length >= limit) break;
  }
  return collected;
}

function nextEvent(type: string, created: number, data: Record<string, unknown>): unknown {
  return { id: `evt_${created}`, created, type, data };
}

it.effect("applies model/agent/instructions before prompting", () =>
  Effect.gen(function* () {
    const { client, calls } = makeRuntime([]);
    const compat = createOpenCodeCompatClient({ client, directory: "/workspace" }) as unknown as {
      session: {
        promptAsync: (input: unknown) => Promise<unknown>;
      };
    };

    yield* Effect.promise(() =>
      compat.session.promptAsync({
        sessionID: "ses_1",
        messageID: "msg_user",
        model: { providerID: "anthropic", modelID: "claude" },
        agent: "plan",
        variant: "high",
        system: "T3 runtime instructions",
        parts: [{ type: "text", text: "hello" }],
      }),
    );

    NodeAssert.equal(calls.switchedModels.length, 1);
    NodeAssert.equal(calls.switchedAgents.length, 1);
    NodeAssert.equal(calls.instructions.length, 0);
    NodeAssert.deepEqual(calls.prompts[0], {
      sessionID: "ses_1",
      id: "msg_user",
      text: "T3 runtime instructions\n\nhello",
    });
  }),
);

it.effect("translates OpenCode 2 text events into legacy part events", () =>
  Effect.gen(function* () {
    const events = [
      nextEvent("session.text.started", 1, {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        ordinal: 0,
      }),
      nextEvent("session.text.delta", 2, {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "Hel",
      }),
      nextEvent("session.text.delta", 3, {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "lo",
      }),
      nextEvent("session.text.ended", 4, {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        ordinal: 0,
        text: "Hello",
      }),
    ];
    const { client } = makeRuntime(events);
    const compat = createOpenCodeCompatClient({ client, directory: "/workspace" }) as unknown as {
      event: {
        subscribe: (
          input: unknown,
          options: unknown,
        ) => Promise<{ stream: AsyncIterable<LegacyEvent> }>;
      };
    };

    const subscription = yield* Effect.promise(() => compat.event.subscribe(undefined, {}));
    const collected = yield* Effect.promise(() => collectEvents(subscription.stream, 5));

    NodeAssert.deepEqual(
      collected.map((event) => event.type),
      [
        "message.updated",
        "message.part.updated",
        "message.part.updated",
        "message.part.updated",
        "message.part.updated",
      ],
    );
    const first = collected[0] as unknown as {
      properties: { sessionID: string; info: { role: string } };
    };
    NodeAssert.equal(first.properties.sessionID, "ses_1");
    NodeAssert.equal(first.properties.info.role, "assistant");
    const last = collected[4] as unknown as {
      properties: {
        sessionID: string;
        part: { type: string; text: string; time: { end?: number } };
      };
    };
    NodeAssert.equal(last.properties.sessionID, "ses_1");
    NodeAssert.equal(last.properties.part.type, "text");
    NodeAssert.equal(last.properties.part.text, "Hello");
    NodeAssert.equal(last.properties.part.time.end, 4);
  }),
);
