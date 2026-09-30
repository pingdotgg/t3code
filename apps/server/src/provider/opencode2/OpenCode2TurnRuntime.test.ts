import { describe, it, assert } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";

import {
  abortOpenCode2Turn,
  compactOpenCode2Thread,
  completeOpenCode2Turn,
  interruptOpenCode2Turn,
  recordOpenCode2TurnUsage,
  sendOpenCode2Turn,
} from "./OpenCode2TurnRuntime.ts";
import {
  makeOpenCode2SessionStore,
  startOpenCode2Session,
  type OpenCode2SessionClient,
} from "./OpenCode2SessionStore.ts";
import { makeOpenCode2ResumeCursor } from "./OpenCode2Protocol.ts";

const threadId = ThreadId.make("thread-oc2-turn");
const boundInstanceId = ProviderInstanceId.make("opencode2");

interface TurnCalls {
  readonly switchedModel: Array<{ readonly model: string; readonly variant: string | undefined }>;
  readonly switchedAgent: Array<string>;
  readonly prompts: Array<{ model: string; agent?: string; parts: number }>;
  readonly commands: Array<{ command: string; args: string }>;
  aborts: number;
}

const makeClient = (calls: TurnCalls, sessionId: string): OpenCode2SessionClient => ({
  session: {
    create: () => Promise.resolve({ data: { id: sessionId, directory: "/work/dir" } }),
    get: () => Promise.reject(Object.assign(new Error("missing"), { status: 404 })),
    list: () => Promise.resolve({ data: [] }),
    fork: () => Promise.resolve({ data: { id: "ses_fork", directory: "/work/dir" } }),
    move: () => Promise.resolve({ data: { id: sessionId } }),
    wait: () => Promise.resolve(undefined),
    interrupt: () => Promise.resolve(undefined),
    update: () => Promise.resolve(undefined),
    abort: () => {
      calls.aborts += 1;
      return Promise.resolve(undefined);
    },
    switchModel: (input) => {
      calls.switchedModel.push({ model: input.model, variant: input.variant });
      return Promise.resolve(undefined);
    },
    switchAgent: (input) => {
      if (input.agent !== undefined) {
        calls.switchedAgent.push(input.agent);
      }
      return Promise.resolve(undefined);
    },
    promptAsync: (input) => {
      calls.prompts.push({
        model: `${input.model.providerID}/${input.model.modelID}`,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        parts: input.parts.length,
      });
      return Promise.resolve(undefined);
    },
    command: (input) => {
      calls.commands.push({ command: input.command, args: input.arguments });
      return Promise.resolve(undefined);
    },
    messages: () => Promise.resolve({ data: [] }),
  },
  permission: { reply: () => Promise.resolve(undefined) },
  question: { reply: () => Promise.resolve(undefined) },
  event: {
    subscribe: () =>
      Promise.resolve({
        stream: (async function* () {
          yield { type: "server.connected" };
        })(),
      }),
  },
});

const settings = {
  enabled: true,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
} as const;

const setup = (sessionId = "ses_1") =>
  Effect.gen(function* () {
    const store = makeOpenCode2SessionStore();
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const calls: TurnCalls = {
      switchedModel: [],
      switchedAgent: [],
      prompts: [],
      commands: [],
      aborts: 0,
    };
    const client = makeClient(calls, sessionId);
    yield* startOpenCode2Session(
      store,
      { threadId, runtimeMode: "full-access" },
      settings,
      boundInstanceId,
      "/work/dir",
      {
        createClient: () => Effect.succeed(client),
        sameDirectory: (left, right) => Effect.succeed(left === right),
        buildPermissionRules: () => [],
        nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
      },
    );
    return { store, events, calls };
  });

const turnDeps = {
  boundInstanceId,
  attachmentsDir: "/attachments",
  resolveAttachmentPath: () => null,
  randomTurnId: Effect.succeed("t1"),
  randomMessageId: Effect.succeed("msg_1"),
  randomEventId: Effect.succeed("evt_1"),
  nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
};

describe("OpenCode2TurnRuntime", () => {
  it.effect("submits a prompt and emits turn.started", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      assert.equal(calls.prompts.length, 1);
      assert.equal(calls.prompts[0]!.model, "anthropic/claude-x");
      assert.equal(calls.prompts[0]!.parts, 1);
      assert.deepEqual(result.resumeCursor, makeOpenCode2ResumeCursor("ses_1"));
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "turn.started");
      assert.equal(String(result.turnId).startsWith("opencode2-turn-"), true);
    }),
  );

  it.effect("switches model and agent in-session before prompting", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: boundInstanceId,
            model: "openai/gpt-x",
            options: [
              { id: "agent", value: "plan" },
              { id: "variant", value: "high" },
            ],
          },
        },
        turnDeps,
      );
      assert.deepEqual(calls.switchedAgent, ["plan"]);
      assert.deepEqual(calls.switchedModel, [{ model: "openai/gpt-x", variant: "high" }]);
      assert.equal(calls.prompts[0]!.agent, "plan");
    }),
  );

  it.effect("rejects selections bound to another instance", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const exit = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("other"),
            model: "anthropic/claude-x",
          },
        },
        turnDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects empty turns without attachments", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const exit = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("steers the active turn instead of starting a new one", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      const first = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "one",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      const second = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "two",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      assert.equal(second.turnId, first.turnId);
      assert.equal(calls.prompts.length, 2);
      // One turn.started for the fresh turn; the steer emits none.
      assert.equal(yield* Queue.size(events), 1);
    }),
  );

  it.effect("routes slash commands through session.command", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "/compact focus",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        { ...turnDeps, listSlashCommands: [{ name: "compact" }] },
      );
      assert.equal(calls.commands.length, 1);
      assert.deepEqual(calls.commands[0], { command: "compact", args: "focus" });
      assert.equal(calls.prompts.length, 0);
    }),
  );

  it.effect("interrupt aborts the active turn and clears it", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* interruptOpenCode2Turn(store, threadId, result.turnId);
      assert.equal(calls.aborts, 1);
      // A mismatched turn id is a no-op.
      yield* interruptOpenCode2Turn(store, threadId, TurnId.make("other-turn"));
      assert.equal(calls.aborts, 1);
    }),
  );
});

describe("compactOpenCode2Thread", () => {
  interface CompactCalls {
    switchedModel: Array<{ readonly model: string; readonly variant: string | undefined }>;
    compacts: number;
    waits: number;
  }

  const makeCompactClient = (calls: CompactCalls): OpenCode2SessionClient => ({
    session: {
      create: () => Promise.resolve({ data: { id: "ses_1", directory: "/work/dir" } }),
      get: () => Promise.reject(Object.assign(new Error("missing"), { status: 404 })),
      list: () => Promise.resolve({ data: [] }),
      fork: () => Promise.resolve({ data: { id: "ses_fork", directory: "/work/dir" } }),
      move: () => Promise.resolve({ data: { id: "ses_1" } }),
      wait: () => {
        calls.waits += 1;
        return Promise.resolve(undefined);
      },
      compact: () => {
        calls.compacts += 1;
        return Promise.resolve(undefined);
      },
      interrupt: () => Promise.resolve(undefined),
      update: () => Promise.resolve(undefined),
      abort: () => Promise.resolve(undefined),
      switchModel: (input) => {
        calls.switchedModel.push({ model: input.model, variant: input.variant });
        return Promise.resolve(undefined);
      },
      switchAgent: () => Promise.resolve(undefined),
      promptAsync: () => Promise.resolve(undefined),
      command: () => Promise.resolve(undefined),
      messages: () => Promise.resolve({ data: [] }),
    },
    permission: { reply: () => Promise.resolve(undefined) },
    question: { reply: () => Promise.resolve(undefined) },
    event: {
      subscribe: () =>
        Promise.resolve({
          stream: (async function* () {
            yield { type: "server.connected" };
          })(),
        }),
    },
  });

  const compactSetup = Effect.gen(function* () {
    const store = makeOpenCode2SessionStore();
    const calls: CompactCalls = { switchedModel: [], compacts: 0, waits: 0 };
    yield* startOpenCode2Session(
      store,
      { threadId, runtimeMode: "full-access" },
      settings,
      boundInstanceId,
      "/work/dir",
      {
        createClient: () => Effect.succeed(makeCompactClient(calls)),
        sameDirectory: (left, right) => Effect.succeed(left === right),
        buildPermissionRules: () => [],
        nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
      },
    );
    return { store, calls };
  });

  const compactDeps = { boundInstanceId };

  it.effect("compacts and waits for the session to settle", () =>
    Effect.gen(function* () {
      const { store, calls } = yield* compactSetup;
      yield* compactOpenCode2Thread(
        store,
        threadId,
        { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        compactDeps,
      );
      // Model differs from the session default, so it switches in-session
      // first, then compacts and waits.
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: undefined }]);
      assert.equal(calls.compacts, 1);
      assert.equal(calls.waits, 1);
    }),
  );

  it.effect("rejects compaction while a turn is running", () =>
    Effect.gen(function* () {
      const { store, calls } = yield* compactSetup;
      const context = store.get(threadId);
      assert.isDefined(context);
      context!.activeTurnId = "opencode2-turn-1";
      const exit = yield* compactOpenCode2Thread(
        store,
        threadId,
        { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        compactDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterValidationError");
      assert.equal(calls.compacts, 0);
      assert.equal(calls.waits, 0);
    }),
  );
});

describe("OpenCode2TurnRuntime lifecycle fixes", () => {
  it.effect("does not mark the turn running when submission fails", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          promptAsync: () => Promise.reject(new Error("transport down")),
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const exit = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      // No phantom active turn: compaction proceeds and interrupt is a no-op.
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
      assert.equal(yield* Queue.size(events), 0);
      yield* interruptOpenCode2Turn(store, threadId);
    }),
  );

  it.effect("rejects concurrent sendTurn while a submission is in flight", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const context = store.get(threadId);
      assert.isDefined(context);
      context!.sendTurnInFlight = true;
      const exit = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterValidationError");
      context!.sendTurnInFlight = false;
    }),
  );

  it.effect("interrupt prefers native session.interrupt and clears the turn", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup("ses_interrupt");
      const interrupts: Array<{ sessionID: string }> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          interrupt: (input: { sessionID: string }) => {
            interrupts.push(input);
            return Promise.resolve({ interrupted: true });
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* interruptOpenCode2Turn(store, threadId, result.turnId);
      assert.deepEqual(interrupts, [{ sessionID: "ses_interrupt" }]);
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
      assert.equal(store.get(threadId)?.session.status, "ready");
    }),
  );

  it.effect("interrupt clears the local turn when the server reports nothing to stop", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup("ses_settled");
      let aborts = 0;
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          interrupt: () => Promise.resolve({ interrupted: false }),
          abort: () => {
            aborts += 1;
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* interruptOpenCode2Turn(store, threadId, result.turnId);
      assert.equal(aborts, 0);
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
    }),
  );

  it.effect("interrupt aborts subagent descendants recursively", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup("ses_parent");
      const aborted: Array<string> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          interrupt: () => Promise.resolve({ interrupted: true }),
          abort: (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return Promise.resolve(undefined);
          },
          children: (input: { sessionID: string }) => {
            const tree: Record<string, Array<string>> = {
              ses_parent: ["ses_child_a", "ses_child_b"],
              ses_child_a: ["ses_grandchild"],
              ses_child_b: [],
              ses_grandchild: [],
            };
            return Promise.resolve({
              data: (tree[input.sessionID] ?? []).map((id) => ({ id })),
            });
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* interruptOpenCode2Turn(store, threadId, result.turnId);
      assert.deepEqual([...aborted].sort(), [
        "ses_child_a",
        "ses_child_b",
        "ses_grandchild",
        "ses_parent",
      ]);
    }),
  );

  it.effect("falls back to binding command.list for slash routing", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          listCommands: () => Promise.resolve({ data: [{ name: "compact" }] }),
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "/compact focus",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      assert.equal(calls.commands.length, 1);
      assert.deepEqual(calls.commands[0], { command: "compact", args: "focus" });
    }),
  );

  it.effect("falls back to the default agent when the selection names none", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        { ...turnDeps, defaultAgent: "plan" },
      );
      assert.deepEqual(calls.switchedAgent, ["plan"]);
      assert.equal(calls.prompts[0]!.agent, "plan");
    }),
  );
});

describe("OpenCode2TurnRuntime pump-in settle", () => {
  const eventDeps = {
    randomEventId: Effect.succeed("evt_settle_1"),
    nowIso: Effect.succeed("2026-09-29T00:00:01.000Z"),
  };

  const sendFirstTurn = () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      // Drain turn.started; the settle assertions below read only what the
      // completion path emits.
      yield* Queue.take(events);
      return { store, events, turnId: result.turnId };
    });

  it.effect("completion clears the turn and emits turn.completed with drained usage", () =>
    Effect.gen(function* () {
      const { store, events, turnId } = yield* sendFirstTurn();
      yield* recordOpenCode2TurnUsage(
        store,
        threadId,
        {
          usedTokens: 22,
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 7,
          reasoningOutputTokens: 2,
        },
        "ses_1",
      );
      yield* completeOpenCode2Turn(
        store,
        threadId,
        turnId,
        { state: "completed" },
        {
          events,
          ...eventDeps,
        },
      );
      const context = store.get(threadId);
      assert.equal(context?.activeTurnId, undefined);
      assert.equal(context?.session.status, "ready");
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "turn.completed");
      const payload = (emitted as unknown as { payload: Record<string, unknown> }).payload;
      assert.equal(payload["state"], "completed");
      assert.deepEqual(payload["tokenUsage"], {
        usageStatus: "complete",
        usageScope: "main_agent",
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 7,
        reasoningTokens: 2,
        hasSubagents: false,
      });
    }),
  );

  it.effect("completion is a no-op for a stale turn id", () =>
    Effect.gen(function* () {
      const { store, events, turnId } = yield* sendFirstTurn();
      yield* completeOpenCode2Turn(
        store,
        threadId,
        TurnId.make("opencode2-turn-stale"),
        { state: "completed" },
        { events, ...eventDeps },
      );
      assert.equal(store.get(threadId)?.activeTurnId, turnId);
      assert.equal(yield* Queue.size(events), 0);
    }),
  );

  it.effect("abort path emits turn.aborted with partial usage and stops descendants", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup("ses_abort_parent");
      const aborted: Array<string> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          abort: (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return Promise.resolve(undefined);
          },
          children: () => Promise.resolve({ data: [{ id: "ses_abort_child" }] }),
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const result = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* Queue.take(events);
      yield* recordOpenCode2TurnUsage(
        store,
        threadId,
        {
          usedTokens: 9,
          inputTokens: 6,
          outputTokens: 3,
        },
        "ses_abort_parent",
      );
      // A subagent-owned frame marks the turn partial without settling it.
      yield* recordOpenCode2TurnUsage(
        store,
        threadId,
        {
          usedTokens: 4,
          inputTokens: 4,
          outputTokens: 0,
        },
        "ses_abort_child",
      );
      yield* abortOpenCode2Turn(store, threadId, result.turnId, "interrupted", {
        events,
        ...eventDeps,
      });
      assert.deepEqual([...aborted].sort(), ["ses_abort_child", "ses_abort_parent"]);
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "turn.aborted");
      const payload = (emitted as unknown as { payload: Record<string, unknown> }).payload;
      assert.equal(payload["reason"], "interrupted");
      assert.deepEqual(payload["tokenUsage"], {
        usageStatus: "partial",
        usageScope: "main_agent",
        inputTokens: 6,
        cachedInputTokens: 0,
        outputTokens: 3,
        reasoningTokens: 0,
        hasSubagents: true,
      });
    }),
  );

  it.effect("usage accumulation is a no-op after the turn settles", () =>
    Effect.gen(function* () {
      const { store, events, turnId } = yield* sendFirstTurn();
      yield* completeOpenCode2Turn(
        store,
        threadId,
        turnId,
        { state: "completed" },
        {
          events,
          ...eventDeps,
        },
      );
      yield* Queue.take(events);
      yield* recordOpenCode2TurnUsage(
        store,
        threadId,
        {
          usedTokens: 5,
          inputTokens: 5,
          outputTokens: 0,
        },
        "ses_1",
      );
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
      assert.equal(yield* Queue.size(events), 0);
    }),
  );
});

describe("OpenCode2TurnRuntime slug variant", () => {
  const capturePromptVariant = () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup();
      const seen: Array<{ readonly variant: string | undefined }> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          promptAsync: (input: { readonly variant?: string | undefined }) => {
            seen.push({ variant: input.variant });
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      return { store, events, calls, seen };
    });

  it.effect("honors the slug #variant when options name none", () =>
    Effect.gen(function* () {
      const { store, events, calls, seen } = yield* capturePromptVariant();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x#high" },
        },
        turnDeps,
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.variant, "high");
      // switchModel receives the clean provider/model slug plus the variant,
      // never the #fragment.
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: "high" }]);
      assert.equal(store.get(threadId)?.activeVariant, "high");
    }),
  );

  it.effect("prefers the options variant over the slug #variant", () =>
    Effect.gen(function* () {
      const { store, events, calls, seen } = yield* capturePromptVariant();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: boundInstanceId,
            model: "anthropic/claude-x#low",
            options: [{ id: "variant", value: "high" }],
          },
        },
        turnDeps,
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.variant, "high");
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: "high" }]);
      assert.equal(store.get(threadId)?.activeVariant, "high");
    }),
  );

  it.effect("sends no variant when neither slug nor options name one", () =>
    Effect.gen(function* () {
      const { store, events, calls, seen } = yield* capturePromptVariant();
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.variant, undefined);
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: undefined }]);
      assert.equal(store.get(threadId)?.activeVariant, undefined);
    }),
  );
});

describe("OpenCode2TurnRuntime switchModel variant", () => {
  it.effect("switchModel receives variant from slug fallback end-to-end", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const seen: Array<{ readonly model: string; readonly variant: string | undefined }> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          switchModel: (input: {
            readonly model: string;
            readonly variant?: string | undefined;
          }) => {
            seen.push({ model: input.model, variant: input.variant });
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x#high" },
        },
        turnDeps,
      );
      assert.deepEqual(seen, [{ model: "anthropic/claude-x", variant: "high" }]);
    }),
  );
});

describe("OpenCode2TurnRuntime applied-model tracking", () => {
  const setupWithStartModel = (startModel: string) =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const calls: TurnCalls = {
        switchedModel: [],
        switchedAgent: [],
        prompts: [],
        commands: [],
        aborts: 0,
      };
      const client = makeClient(calls, "ses_1");
      yield* startOpenCode2Session(
        store,
        {
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: boundInstanceId, model: startModel },
        },
        settings,
        boundInstanceId,
        "/work/dir",
        {
          createClient: () => Effect.succeed(client),
          sameDirectory: (left, right) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      return { store, events, calls };
    });

  it.effect("applies the start selection on the first turn even when it matches", () =>
    Effect.gen(function* () {
      // The session record carries the start selection, but session.create
      // never sent it to the server — the first turn must switch so it runs
      // on the selection instead of the server default.
      const { store, events, calls } = yield* setupWithStartModel("anthropic/claude-x");
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: undefined }]);
    }),
  );

  it.effect("switches on a variant-only change when the model slug matches", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setupWithStartModel("anthropic/claude-x");
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "one",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      );
      yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "two",
          modelSelection: {
            instanceId: boundInstanceId,
            model: "anthropic/claude-x",
            options: [{ id: "variant", value: "high" }],
          },
        },
        turnDeps,
      );
      assert.deepEqual(calls.switchedModel, [
        { model: "anthropic/claude-x", variant: undefined },
        { model: "anthropic/claude-x", variant: "high" },
      ]);
    }),
  );

  it.effect("skips the switch when the model and variant already applied", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setupWithStartModel("anthropic/claude-x");
      const first = {
        threadId,
        input: "one",
        modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
      };
      yield* sendOpenCode2Turn(store, events, first, turnDeps);
      // A steering send reuses the active turn; with the same model it must
      // not re-apply.
      yield* sendOpenCode2Turn(store, events, { ...first, input: "two" }, turnDeps);
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: undefined }]);
    }),
  );

  it.effect("compaction applies a start-matching selection the session never received", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const calls: TurnCalls = {
        switchedModel: [],
        switchedAgent: [],
        prompts: [],
        commands: [],
        aborts: 0,
      };
      let compacts = 0;
      let waits = 0;
      const client = makeClient(calls, "ses_1");
      const compactClient = {
        ...client,
        session: {
          ...client.session,
          wait: () => {
            waits += 1;
            return Promise.resolve(undefined);
          },
          compact: () => {
            compacts += 1;
            return Promise.resolve(undefined);
          },
        },
      } as unknown as OpenCode2SessionClient;
      yield* startOpenCode2Session(
        store,
        {
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        settings,
        boundInstanceId,
        "/work/dir",
        {
          createClient: () => Effect.succeed(compactClient),
          sameDirectory: (left, right) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      yield* compactOpenCode2Thread(
        store,
        threadId,
        { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        { boundInstanceId },
      );
      assert.deepEqual(calls.switchedModel, [{ model: "anthropic/claude-x", variant: undefined }]);
      assert.equal(compacts, 1);
      assert.equal(waits, 1);
    }),
  );
});

describe("OpenCode2TurnRuntime hardening (sweep A)", () => {
  it.effect("serializes overlapping sendTurn fibers through the prompt semaphore", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const order: Array<string> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      // Slow promptAsync: the first submission parks inside the permit while
      // the second fiber queues on the semaphore instead of racing into the
      // session concurrently. Deferred gates (not yield-counting) order the
      // fibers deterministically.
      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = yield* Deferred.make<void>();
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          promptAsync: (_input: {
            model: { providerID: string; modelID: string };
            parts: ReadonlyArray<unknown>;
          }) => {
            order.push("enter");
            Deferred.doneUnsafe(entered, Effect.void);
            return parked.then(() => {
              order.push("exit");
              return undefined;
            });
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      const first = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "one",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      ).pipe(Effect.forkChild);
      // Wait until the first fiber is parked inside promptAsync (permit held,
      // flag set) before forking the second fiber.
      yield* Deferred.await(entered);
      const second = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "two",
          modelSelection: { instanceId: boundInstanceId, model: "anthropic/claude-x" },
        },
        turnDeps,
      ).pipe(Effect.forkChild);
      for (let index = 0; index < 20; index += 1) {
        yield* Effect.yieldNow;
      }
      // The second fiber hit the in-flight fast-path: it must not submit
      // while the first is parked (no second prompt entry).
      assert.deepEqual(order, ["enter"]);
      release();
      const firstResult = yield* Fiber.join(first);
      // The queued second fiber was rejected fast (validation error surfaces
      // through the forked fiber's failure channel).
      const secondExit = yield* Fiber.await(second);
      assert.equal(Exit.isFailure(secondExit), true);
      assert.isDefined(firstResult.turnId);
    }),
  );

  it.effect("switchModel send path carries the 10s submission budget", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup();
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        session: {
          ...context!.client.session,
          switchModel: () => new Promise<never>(() => {}),
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      // The hanging switchModel must trip the 10s submission budget, not
      // hang the suite: race the send against the TestClock so the timeout
      // fires on virtual time.
      const fiber = yield* sendOpenCode2Turn(
        store,
        events,
        {
          threadId,
          input: "hello",
          modelSelection: { instanceId: boundInstanceId, model: "openai/gpt-x" },
        },
        turnDeps,
      ).pipe(Effect.forkChild);
      for (let step = 0; step < 20; step += 1) {
        yield* Effect.yieldNow;
        if (yield* Effect.sync(() => fiber.pollUnsafe() !== undefined)) {
          break;
        }
        yield* TestClock.adjust(Duration.millis(1_000));
      }
      const exit = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      assert.match(
        (exit as unknown as { detail: string }).detail,
        /did not complete within 10 seconds/,
      );
      // Failed admission leaves no phantom active turn.
      assert.equal(store.get(threadId)?.activeTurnId, undefined);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
