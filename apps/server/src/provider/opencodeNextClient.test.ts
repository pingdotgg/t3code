import * as NodeAssert from "node:assert/strict";

import type { Event as LegacyEvent } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OpenCodeNextClient } from "./opencodeRuntime.ts";
import { createOpenCodeCompatClient } from "./opencodeNextClient.ts";

interface RuntimeCalls {
  readonly switchedModels: Array<unknown>;
  readonly switchedAgents: Array<unknown>;
  readonly instructions: Array<unknown>;
  readonly prompts: Array<unknown>;
  readonly commands: Array<unknown>;
  readonly formReplies: Array<unknown>;
  readonly waits: Array<unknown>;
  readonly contextCalls: Array<unknown>;
}

interface FakeAssistantMessage {
  readonly id: string;
  readonly type: "assistant";
  readonly time: { readonly created: number; readonly completed?: number };
  readonly content: ReadonlyArray<unknown>;
  readonly error?: unknown;
}

function makeRuntime(
  events: ReadonlyArray<unknown>,
  contextMessages: ReadonlyArray<FakeAssistantMessage> = [],
  forms: ReadonlyArray<unknown> = [],
) {
  const calls: RuntimeCalls = {
    switchedModels: [],
    switchedAgents: [],
    instructions: [],
    prompts: [],
    commands: [],
    formReplies: [],
    waits: [],
    contextCalls: [],
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
      command: async (input: unknown) => {
        calls.commands.push(input);
      },
      wait: async (input: unknown) => {
        calls.waits.push(input);
      },
      context: async (input: unknown) => {
        calls.contextCalls.push(input);
        return contextMessages;
      },
      form: {
        reply: async (input: unknown) => {
          calls.formReplies.push(input);
        },
      },
    },
    form: {
      list: async () => ({ data: forms }),
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

it.effect("parses a legacy provider/model string for native commands", () =>
  Effect.gen(function* () {
    const { client, calls } = makeRuntime([]);
    const compat = createOpenCodeCompatClient({ client, directory: "/workspace" }) as unknown as {
      session: { command: (input: unknown) => Promise<unknown> };
    };

    yield* Effect.promise(() =>
      compat.session.command({
        sessionID: "ses_1",
        messageID: "msg_user",
        command: "review",
        arguments: "arg",
        model: "anthropic/claude",
        agent: "build",
        variant: "high",
        parts: [{ type: "text", text: "hi" }],
      }),
    );

    NodeAssert.deepEqual(calls.switchedModels[0], {
      sessionID: "ses_1",
      model: { id: "claude", providerID: "anthropic", variant: "high" },
    });
    NodeAssert.deepEqual(calls.commands[0], {
      sessionID: "ses_1",
      name: "review",
      text: "arg",
    });
  }),
);

it.effect("session.prompt waits for the turn and returns the assistant message", () =>
  Effect.gen(function* () {
    const assistant = {
      id: "msg_a",
      type: "assistant" as const,
      time: { created: 1, completed: 2 },
      content: [{ type: "text", text: "Hello" }],
    };
    const { client, calls } = makeRuntime([], [assistant]);
    const compat = createOpenCodeCompatClient({ client, directory: "/workspace" }) as unknown as {
      session: {
        prompt: (input: unknown) => Promise<{
          data: {
            info: { id: string; role: string; error?: unknown };
            parts: Array<{ type: string; text: string }>;
          };
        }>;
      };
    };

    const result = yield* Effect.promise(() =>
      compat.session.prompt({
        sessionID: "ses_1",
        model: { providerID: "anthropic", modelID: "claude" },
        agent: "build",
        parts: [{ type: "text", text: "hello" }],
      }),
    );

    NodeAssert.deepEqual(calls.prompts[0], { sessionID: "ses_1", text: "hello" });
    NodeAssert.deepEqual(calls.waits[0], { sessionID: "ses_1" });
    NodeAssert.equal(result.data.info.id, "msg_a");
    NodeAssert.equal(result.data.info.role, "assistant");
    NodeAssert.equal(result.data.parts[0]?.text, "Hello");
  }),
);

it.effect("translates a V2 form reply into ordered legacy answers", () =>
  Effect.gen(function* () {
    const events = [
      nextEvent("form.created", 1, {
        sessionID: "ses_1",
        form: {
          id: "form_1",
          sessionID: "ses_1",
          title: "Questions",
          fields: [
            { key: "q1", type: "select", title: "One" },
            { key: "q2", type: "multiselect", title: "Two" },
          ],
        },
      }),
      nextEvent("form.replied", 2, {
        sessionID: "ses_1",
        id: "form_1",
        answer: { q1: "a", q2: ["b", "c"] },
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
    const collected = yield* Effect.promise(() => collectEvents(subscription.stream, 2));

    NodeAssert.deepEqual(
      collected.map((event) => event.type),
      ["question.asked", "question.replied"],
    );
    const replied = collected[1] as unknown as {
      properties: { answers: Array<Array<string>> };
    };
    NodeAssert.deepEqual(replied.properties.answers, [["a"], ["b", "c"]]);
  }),
);

it.effect("marks multiselect forms and normalizes answers for OpenCode 2", () =>
  Effect.gen(function* () {
    const forms = [
      {
        id: "form_1",
        sessionID: "ses_1",
        title: "Questions",
        fields: [
          { key: "q1", type: "select", title: "One" },
          { key: "q2", type: "multiselect", title: "Two" },
        ],
      },
    ];
    const { client, calls } = makeRuntime([], [], forms);
    const compat = createOpenCodeCompatClient({ client, directory: "/workspace" }) as unknown as {
      question: {
        list: () => Promise<{ data: Array<{ questions: Array<{ multiple?: boolean }> }> }>;
        reply: (input: unknown) => Promise<unknown>;
      };
    };

    const listed = yield* Effect.promise(() => compat.question.list());
    NodeAssert.equal(listed.data[0]?.questions[0]?.multiple, false);
    NodeAssert.equal(listed.data[0]?.questions[1]?.multiple, true);

    yield* Effect.promise(() =>
      compat.question.reply({ requestID: "form_1", answers: [["a"], ["b", "c"]] }),
    );
    NodeAssert.deepEqual(calls.formReplies[0], {
      sessionID: "ses_1",
      formID: "form_1",
      answer: { q1: "a", q2: ["b", "c"] },
    });
  }),
);
