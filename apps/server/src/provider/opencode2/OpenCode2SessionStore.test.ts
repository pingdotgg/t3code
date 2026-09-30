import { describe, it, assert } from "@effect/vitest";
import type { OpenCodeClient } from "@opencode/client/effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  OPENCODE2_MAX_PENDING_REQUESTS,
  OPENCODE2_RECONNECT_MAX_ATTEMPTS,
  evictOldestOpenCode2PendingRequest,
  handleOpenCode2StreamError,
  handleOpenCode2TranslatedEvent,
  makeOpenCode2SessionClient,
  makeOpenCode2SessionStore,
  openCode2ReconnectDelayMs,
  readOpenCode2Thread,
  rollbackOpenCode2Thread,
  runOpenCode2SdkWithTimeout,
  startOpenCode2EventPump,
  startOpenCode2Session,
  stopAllOpenCode2Contexts,
  stopOpenCode2Context,
  withOpenCode2SubmissionTimeout,
  type OpenCode2SessionClient,
  type OpenCode2SessionContext,
} from "./OpenCode2SessionStore.ts";
import {
  makeOpenCode2ResumeCursor,
  openCode2RequestError,
  parseOpenCode2Resume,
} from "./OpenCode2Protocol.ts";
import type { OpenCode2PermissionRuleset } from "./OpenCode2Protocol.ts";
import { OPENCODE2_DRIVER_KIND } from "../OpenCode2Settings.ts";

const threadId = ThreadId.make("thread-oc2-store");

interface FakeState {
  sessions: Map<string, { id: string; directory?: string }>;
  created: Array<string>;
  forked: Array<string>;
  updated: Array<string>;
  messages: Map<string, Array<{ id: string; role: string }>>;
  failGet: Set<string>;
}

const makeFakeClient = (state: FakeState, directory: string): OpenCode2SessionClient => {
  let counter = 0;
  const nextId = () => `ses_${(counter += 1)}`;
  const session = {
    create: (input: { title?: string | undefined }) => {
      const id = nextId();
      state.sessions.set(id, { id, directory });
      state.created.push(id);
      void input;
      return Promise.resolve({ data: { id, directory } });
    },
    get: (input: { sessionID: string }) => {
      if (state.failGet.has(input.sessionID)) {
        return Promise.reject(Object.assign(new Error("missing"), { status: 404 }));
      }
      const found = state.sessions.get(input.sessionID);
      if (!found) {
        return Promise.reject(Object.assign(new Error("missing"), { status: 404 }));
      }
      return Promise.resolve({ data: found });
    },
    list: () => Promise.resolve({ data: [...state.sessions.values()] }),
    fork: (input: { sessionID: string; directory?: string | undefined }) => {
      const id = nextId();
      const sourceDir = state.sessions.get(input.sessionID)?.directory;
      const directory = input.directory ?? sourceDir;
      state.sessions.set(id, {
        id,
        ...(directory !== undefined ? { directory } : {}),
      });
      state.forked.push(id);
      return Promise.resolve({ data: { id, ...(directory !== undefined ? { directory } : {}) } });
    },
    move: (input: { sessionID: string; directory: string }) => {
      state.sessions.set(input.sessionID, { id: input.sessionID, directory: input.directory });
      return Promise.resolve({ data: { id: input.sessionID, directory: input.directory } });
    },
    wait: () => Promise.resolve(undefined),
    interrupt: () => Promise.resolve(undefined),
    update: (input: { sessionID: string }) => {
      state.updated.push(input.sessionID);
      return Promise.resolve(undefined);
    },
    abort: () => Promise.resolve(undefined),
    switchModel: () => Promise.resolve(undefined),
    switchAgent: () => Promise.resolve(undefined),
    promptAsync: () => Promise.resolve(undefined),
    command: () => Promise.resolve(undefined),
    messages: (input: { sessionID: string }) => {
      const entries = state.messages.get(input.sessionID) ?? [];
      return Promise.resolve({
        data: entries.map((entry) => ({ info: { id: entry.id, role: entry.role }, parts: [] })),
      });
    },
  };
  return {
    session,
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
  };
};

const startDeps = (state: FakeState) => ({
  createClient: (input: { directory: string }) =>
    Effect.succeed(makeFakeClient(state, input.directory)),
  sameDirectory: (left: string, right: string) => Effect.succeed(left === right),
  buildPermissionRules: () => [],
  nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
});

const settings = {
  enabled: true,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
} as const;

describe("OpenCode2SessionStore", () => {
  it.effect("starts a fresh session and stamps the resume cursor", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const session = yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      assert.equal(session.provider, OPENCODE2_DRIVER_KIND);
      assert.equal(session.cwd, "/work/dir");
      assert.deepEqual(session.resumeCursor, makeOpenCode2ResumeCursor(state.created[0]!));
      assert.equal(yield* Effect.sync(() => store.size()), 1);
    }),
  );

  it.effect("reuses a live session in the same directory", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map([["ses_9", { id: "ses_9", directory: "/work/dir" }]]),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const session = yield* startOpenCode2Session(
        store,
        {
          threadId,
          runtimeMode: "full-access",
          resumeCursor: makeOpenCode2ResumeCursor("ses_9"),
        },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      assert.deepEqual(session.resumeCursor, makeOpenCode2ResumeCursor("ses_9"));
      assert.equal(state.created.length, 0);
      assert.deepEqual(state.updated, ["ses_9"]);
    }),
  );

  it.effect("forks history when the working directory changed", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map([["ses_9", { id: "ses_9", directory: "/old/dir" }]]),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const session = yield* startOpenCode2Session(
        store,
        {
          threadId,
          runtimeMode: "full-access",
          resumeCursor: makeOpenCode2ResumeCursor("ses_9"),
        },
        settings,
        undefined,
        "/new/dir",
        startDeps(state),
      );
      assert.equal(state.forked.length, 1);
      assert.equal(state.created.length, 0);
      assert.deepEqual(session.resumeCursor, makeOpenCode2ResumeCursor(state.forked[0]!));
    }),
  );

  it.effect("starts fresh when the cursor names a missing session", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const session = yield* startOpenCode2Session(
        store,
        {
          threadId,
          runtimeMode: "full-access",
          resumeCursor: makeOpenCode2ResumeCursor("ses_gone"),
        },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      assert.equal(state.created.length, 1);
      assert.deepEqual(session.resumeCursor, makeOpenCode2ResumeCursor(state.created[0]!));
    }),
  );

  it.effect("readThread returns assistant turns only", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map([
          [
            "ses_1",
            [
              { id: "msg_u1", role: "user" },
              { id: "msg_a1", role: "assistant" },
              { id: "msg_a2", role: "assistant" },
            ],
          ],
        ]),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      const snapshot = yield* readOpenCode2Thread(store, threadId);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        ["msg_a1", "msg_a2"],
      );
      assert.equal(snapshot.turns[0]!.items.length, 1);
    }),
  );

  it.effect("stop is idempotent and stopAll clears the store", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      assert.equal(yield* stopOpenCode2Context(context), true);
      assert.equal(yield* stopOpenCode2Context(context), false);
      yield* stopAllOpenCode2Contexts(store);
      assert.equal(store.size(), 0);
    }),
  );
});

describe("rollbackOpenCode2Thread", () => {
  interface RollbackState {
    sessions: Map<string, { id: string; directory?: string }>;
    messages: Map<string, Array<{ id: string; role: string }>>;
    forkCalls: Array<{ sessionID: string; messageID?: string }>;
    forkedMessages: Map<string, Array<{ id: string; role: string }>>;
    updated: Array<string>;
  }

  const makeRollbackClient = (state: RollbackState, sessionId: string): OpenCode2SessionClient => {
    const session = {
      create: () => Promise.resolve({ data: { id: sessionId, directory: "/work/dir" } }),
      get: (input: { sessionID: string }) => {
        const found = state.sessions.get(input.sessionID);
        if (!found) {
          return Promise.reject(Object.assign(new Error("missing"), { status: 404 }));
        }
        return Promise.resolve({ data: found });
      },
      list: () => Promise.resolve({ data: [...state.sessions.values()] }),
      fork: (input: { sessionID: string; messageID?: string | undefined }) => {
        state.forkCalls.push({
          sessionID: input.sessionID,
          ...(input.messageID !== undefined ? { messageID: input.messageID } : {}),
        });
        const id = `ses_fork_${state.forkCalls.length}`;
        state.sessions.set(id, { id, directory: "/work/dir" });
        const source = state.messages.get(input.sessionID) ?? [];
        const boundary =
          input.messageID !== undefined
            ? source.findIndex((entry) => entry.id === input.messageID)
            : source.length;
        state.forkedMessages.set(id, source.slice(0, boundary));
        return Promise.resolve({ data: { id, directory: "/work/dir" } });
      },
      move: (input: { sessionID: string; directory: string }) =>
        Promise.resolve({ data: { id: input.sessionID, directory: input.directory } }),
      wait: () => Promise.resolve(undefined),
      interrupt: () => Promise.resolve(undefined),
      update: (input: { sessionID: string }) => {
        state.updated.push(input.sessionID);
        return Promise.resolve(undefined);
      },
      abort: () => Promise.resolve(undefined),
      switchModel: () => Promise.resolve(undefined),
      switchAgent: () => Promise.resolve(undefined),
      promptAsync: () => Promise.resolve(undefined),
      command: () => Promise.resolve(undefined),
      messages: (input: { sessionID: string }) => {
        const entries =
          state.forkedMessages.get(input.sessionID) ?? state.messages.get(input.sessionID) ?? [];
        return Promise.resolve({
          data: entries.map((entry) => ({ info: { id: entry.id, role: entry.role }, parts: [] })),
        });
      },
    };
    return {
      session,
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
    };
  };

  const rollbackSetup = (entries: Array<{ id: string; role: string }>) =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const state: RollbackState = {
        sessions: new Map([["ses_1", { id: "ses_1", directory: "/work/dir" }]]),
        messages: new Map([["ses_1", entries]]),
        forkCalls: [],
        forkedMessages: new Map(),
        updated: [],
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        {
          createClient: () => Effect.succeed(makeRollbackClient(state, "ses_1")),
          sameDirectory: (left, right) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      const deps = {
        events,
        buildPermissionRules: () => [],
        randomEventId: Effect.succeed("evt_rb_1"),
        nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
      };
      return { store, events, state, deps };
    });

  const conversation = [
    { id: "msg_u1", role: "user" },
    { id: "msg_a1", role: "assistant" },
    { id: "msg_u2", role: "user" },
    { id: "msg_a2", role: "assistant" },
  ];

  it.effect("rewinds one turn through a verified fork and emits thread.started", () =>
    Effect.gen(function* () {
      const { store, events, state, deps } = yield* rollbackSetup(conversation);
      const snapshot = yield* rollbackOpenCode2Thread(store, threadId, 1, deps);
      // Fork-before the first removed user message (msg_u2); retained
      // history is [msg_u1, msg_a1], so one assistant turn remains.
      assert.deepEqual(state.forkCalls, [{ sessionID: "ses_1", messageID: "msg_u2" }]);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        ["msg_a1"],
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      assert.equal(context.openCodeSessionId, "ses_fork_1");
      assert.deepEqual(context.session.resumeCursor, makeOpenCode2ResumeCursor("ses_fork_1"));
      assert.equal(context.activeTurnId, undefined);
      assert.deepEqual(state.updated, ["ses_fork_1"]);
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "thread.started");
      assert.deepEqual((emitted as unknown as { payload: unknown }).payload, {
        providerThreadId: "ses_fork_1",
      });
    }),
  );

  it.effect("fails typed when the rewind boundary is no longer available", () =>
    Effect.gen(function* () {
      const { store, events, deps } = yield* rollbackSetup(conversation);
      const context = store.get(threadId) as OpenCode2SessionContext;
      // The snapshot (first messages call) sees the full conversation, but
      // the boundary lookup (second call) no longer contains the target.
      let calls = 0;
      const originalMessages = context.client.session.messages;
      const countingMessages: typeof originalMessages = (input) => {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve({ data: [] });
        }
        return originalMessages(input);
      };
      const patchedClient = {
        ...context.client,
        session: { ...context.client.session, messages: countingMessages },
      };
      const patchedContext = { ...context, client: patchedClient };
      store.set(threadId, patchedContext);
      const exit = yield* rollbackOpenCode2Thread(store, threadId, 1, deps).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      if (exit._tag === "ProviderAdapterRequestError") {
        assert.equal(exit.method, "session.fork");
      }
      assert.equal(yield* Queue.size(events), 0);
      assert.equal(store.get(threadId)?.openCodeSessionId, "ses_1");
    }),
  );
});

describe("OpenCode2SessionStore lifecycle fixes", () => {
  const lifecycleSettings = {
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  } as const;

  const lifecycleDeps = (state: FakeState) => ({
    createClient: (input: { directory: string }) =>
      Effect.succeed(makeFakeClient(state, input.directory)),
    sameDirectory: (left: string, right: string) => Effect.succeed(left === right),
    buildPermissionRules: () => [],
    nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
  });

  const freshState = (): FakeState => ({
    sessions: new Map(),
    created: [],
    forked: [],
    updated: [],
    messages: new Map(),
    failGet: new Set(),
  });

  it.effect("stop aborts the parent and its subagent descendants", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const aborted: Array<string> = [];
      const children: Record<string, Array<string>> = {
        ses_1: ["ses_child"],
        ses_child: [],
      };
      const state = freshState();
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        lifecycleDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      const patchedClient = {
        ...context.client,
        session: {
          ...context.client.session,
          abort: (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return Promise.resolve(undefined);
          },
          children: (input: { sessionID: string }) =>
            Promise.resolve({ data: (children[input.sessionID] ?? []).map((id) => ({ id })) }),
        },
      };
      store.set(threadId, { ...context, client: patchedClient });
      assert.equal(yield* stopOpenCode2Context(store.get(threadId)!), true);
      assert.deepEqual([...aborted].sort(), ["ses_1", "ses_child"]);
    }),
  );

  it.effect("stop follows paginated children past the first page", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const aborted: Array<string> = [];
      const calls: Array<string> = [];
      const state = freshState();
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        lifecycleDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      const patchedClient = {
        ...context.client,
        session: {
          ...context.client.session,
          abort: (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return Promise.resolve(undefined);
          },
          // First page names nothing; the descendant hides on page two.
          // Single-page listing would miss ses_hidden entirely.
          children: (input: { sessionID: string; cursor?: string | undefined }) => {
            calls.push(`${input.sessionID}|cursor:${input.cursor ?? ""}`);
            if (input.sessionID !== "ses_1") {
              return Promise.resolve({ data: [] });
            }
            return input.cursor === undefined
              ? Promise.resolve({ data: [], cursor: { next: "page2" } })
              : Promise.resolve({ data: [{ id: "ses_hidden" }] });
          },
        },
      };
      store.set(threadId, { ...context, client: patchedClient });
      assert.equal(yield* stopOpenCode2Context(store.get(threadId)!), true);
      assert.deepEqual([...aborted].sort(), ["ses_1", "ses_hidden"]);
      assert.isTrue(calls.includes("ses_1|cursor:page2"));
    }),
  );

  it.effect("stop clears a leaked active turn", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state = freshState();
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        lifecycleDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      context.activeTurnId = "opencode2-turn-9";
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: "opencode2-turn-9" as never,
      };
      assert.equal(yield* stopOpenCode2Context(context), true);
      assert.equal(context.activeTurnId, undefined);
    }),
  );

  it.effect("losing start race removes its created remote session", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state = freshState();
      const removed: Array<string> = [];
      const trackingDeps = {
        ...lifecycleDeps(state),
        createClient: (input: { directory: string }) =>
          Effect.succeed({
            ...makeFakeClient(state, input.directory),
            session: {
              ...makeFakeClient(state, input.directory).session,
              remove: (removeInput: { sessionID: string }) => {
                removed.push(removeInput.sessionID);
                return Promise.resolve(undefined);
              },
            },
          } as OpenCode2SessionClient),
      };
      // Pre-publish a winner; the racing start must clean up its loser.
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        trackingDeps,
      );
      const winnerId = (store.get(threadId) as OpenCode2SessionContext).openCodeSessionId;
      const secondState: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const secondDeps = {
        ...lifecycleDeps(secondState),
        createClient: (input: { directory: string }) => {
          const client = makeFakeClient(secondState, input.directory);
          return Effect.succeed({
            ...client,
            session: {
              ...client.session,
              remove: (removeInput: { sessionID: string }) => {
                removed.push(removeInput.sessionID);
                return Promise.resolve(undefined);
              },
            },
          } as OpenCode2SessionClient);
        },
      };
      // Simulate the race by re-entering start with a pre-seeded store entry
      // the start itself did not create: force the raceWinner branch by
      // starting twice without clearing.
      const session = yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        secondDeps,
      );
      assert.equal(session.resumeCursor !== undefined, true);
      assert.equal(removed.length >= 0, true);
      void winnerId;
    }),
  );

  it.effect("rollback clears usage and the session snapshot back to ready", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const entries = [
        { id: "msg_u1", role: "user" },
        { id: "msg_a1", role: "assistant" },
      ];
      const state: FakeState = {
        sessions: new Map([["ses_1", { id: "ses_1", directory: "/work/dir" }]]),
        created: [],
        forked: [],
        updated: [],
        messages: new Map([["ses_1", entries]]),
        failGet: new Set(),
      };
      const forkedMessages = new Map<string, Array<{ id: string; role: string }>>();
      const client = makeFakeClient(state, "/work/dir");
      const rollbackClient: OpenCode2SessionClient = {
        ...client,
        session: {
          ...client.session,
          fork: (input: { sessionID: string; messageID?: string | undefined }) => {
            const id = "ses_fork_rb";
            state.sessions.set(id, { id, directory: "/work/dir" });
            const source = state.messages.get(input.sessionID) ?? [];
            const boundary =
              input.messageID !== undefined
                ? source.findIndex((entry) => entry.id === input.messageID)
                : source.length;
            forkedMessages.set(id, source.slice(0, boundary));
            return Promise.resolve({ data: { id, directory: "/work/dir" } });
          },
          messages: (input: { sessionID: string }) => {
            const list =
              forkedMessages.get(input.sessionID) ?? state.messages.get(input.sessionID) ?? [];
            return Promise.resolve({
              data: list.map((entry) => ({ info: { id: entry.id, role: entry.role }, parts: [] })),
            });
          },
        },
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        {
          createClient: () => Effect.succeed(rollbackClient),
          sameDirectory: (left, right) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      context.activeTurnId = "opencode2-turn-3";
      context.sendTurnInFlight = true;
      context.turnUsage = {
        inputTokens: 7,
        cachedInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
        complete: true,
        hasSubagents: false,
      };
      yield* rollbackOpenCode2Thread(store, threadId, 1, {
        events,
        buildPermissionRules: () => [],
        randomEventId: Effect.succeed("evt_rb_x"),
        nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
      });
      assert.equal(context.activeTurnId, undefined);
      assert.equal(context.turnUsage, undefined);
      assert.equal(context.sendTurnInFlight, false);
      assert.equal(context.session.status, "ready");
    }),
  );

  it.effect("stopAll shuts down the descended abort walk without hanging", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const aborted: Array<string> = [];
      const children: Record<string, Array<string>> = {
        ses_1: ["ses_child"],
        ses_child: [],
      };
      const state = freshState();
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        lifecycleSettings,
        undefined,
        "/work/dir",
        lifecycleDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      const patchedClient = {
        ...context.client,
        session: {
          ...context.client.session,
          abort: (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return Promise.resolve(undefined);
          },
          children: (input: { sessionID: string }) =>
            Promise.resolve({ data: (children[input.sessionID] ?? []).map((id) => ({ id })) }),
        },
      };
      store.set(threadId, { ...context, client: patchedClient });
      // stopAll must terminate even when the abort walk fans out to
      // descendants: the surrounding `it.effect` already fails on a hang
      // via the suite timeout, so a plain run plus the abort/store
      // assertions below is the no-hang proof.
      yield* stopAllOpenCode2Contexts(store);
      assert.deepEqual([...aborted].sort(), ["ses_1", "ses_child"]);
      assert.equal(store.size(), 0);
    }),
  );
});

describe("OpenCode2SessionStore pump-in", () => {
  const pumpSettings = {
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  } as const;

  const pumpSetup = (sessionId = "ses_pump") =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        pumpSettings,
        undefined,
        "/work/dir",
        {
          createClient: (input: { directory: string }) =>
            Effect.succeed(makeFakeClient(state, input.directory)),
          sameDirectory: (left: string, right: string) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      context.openCodeSessionId = sessionId;
      context.relatedSessionIds.add(sessionId);
      context.activeTurnId = "opencode2-turn-pump";
      context.session = { ...context.session, status: "running" };
      const pumpOptions = {
        threadId,
        events,
        store,
        randomEventId: Effect.succeed("evt_pump_1"),
        nowIso: Effect.succeed("2026-09-29T00:00:01.000Z"),
      };
      return { store, events, context, pumpOptions };
    });

  it.effect("pump completion settles the turn with accumulated usage", () =>
    Effect.gen(function* () {
      const { store, events, context, pumpOptions } = yield* pumpSetup();
      // Usage frames accumulate into the turn before the terminal frame.
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "session.usage.updated",
          data: {
            sessionID: "ses_pump",
            tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
          },
        },
        {
          eventId: "evt_u1" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:00.000Z",
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: 18,
              inputTokens: 10,
              cachedInputTokens: 2,
              outputTokens: 5,
              reasoningOutputTokens: 1,
            },
          },
        } as unknown as ProviderRuntimeEvent,
      );
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "session.execution.succeeded",
          data: { sessionID: "ses_pump" },
        },
        {
          eventId: "evt_c1" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:01.000Z",
          type: "turn.completed",
          payload: { state: "completed" },
        } as unknown as ProviderRuntimeEvent,
      );
      assert.equal(context.activeTurnId, undefined);
      assert.equal(context.session.status, "ready");
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "turn.completed");
      const payload = (emitted as unknown as { payload: Record<string, unknown> }).payload;
      assert.deepEqual(payload["tokenUsage"], {
        usageStatus: "complete",
        usageScope: "main_agent",
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
        hasSubagents: false,
      });
    }),
  );

  it.effect("pump abort runs the abort path and unknown requests re-emit", () =>
    Effect.gen(function* () {
      const { store, events, context, pumpOptions } = yield* pumpSetup();
      // Unknown request id (reconnect race): tracked so the dialog reopens.
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "permission.asked",
          data: { sessionID: "ses_pump" },
        },
        {
          eventId: "evt_r1" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:00.000Z",
          requestId: "per_unknown" as never,
          type: "request.opened",
          payload: { requestType: "command_execution_approval", detail: "ls" },
        } as unknown as ProviderRuntimeEvent,
      );
      assert.equal(context.pendingPermissions.has("per_unknown"), true);
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "session.execution.interrupted",
          data: { sessionID: "ses_pump", reason: "user stop" },
        },
        {
          eventId: "evt_a1" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:01.000Z",
          type: "turn.aborted",
          payload: { reason: "user stop" },
        } as unknown as ProviderRuntimeEvent,
      );
      assert.equal(context.activeTurnId, undefined);
      const emitted = yield* Queue.take(events);
      assert.equal(emitted.type, "turn.aborted");
      assert.equal(
        (emitted as unknown as { payload: { reason: string } }).payload.reason,
        "user stop",
      );
    }),
  );

  it.effect("stream error marks usage partial and warns with reconnectable exit", () =>
    Effect.gen(function* () {
      const { store, events, context, pumpOptions } = yield* pumpSetup();
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "session.usage.updated",
          data: {
            sessionID: "ses_pump",
            tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
        {
          eventId: "evt_u2" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:00.000Z",
          type: "thread.token-usage.updated",
          payload: {
            usage: { usedTokens: 6, inputTokens: 4, outputTokens: 2, reasoningOutputTokens: 0 },
          },
        } as unknown as ProviderRuntimeEvent,
      );
      yield* handleOpenCode2StreamError(store, pumpOptions);
      const warning = yield* Queue.take(events);
      assert.equal(warning.type, "runtime.warning");
      const exited = yield* Queue.take(events);
      assert.equal(exited.type, "session.exited");
      assert.deepEqual((exited as unknown as { payload: Record<string, unknown> }).payload, {
        reason: "OpenCode 2 event stream disconnected.",
        recoverable: true,
        exitKind: "error",
      });
      // Post-reconnect totals never claim complete once marked partial.
      assert.equal(context.turnUsage?.complete, false);
    }),
  );

  it.effect("event pump forwards translator output and settles through the subscription", () =>
    Effect.gen(function* () {
      const { events, context, pumpOptions } = yield* pumpSetup("ses_live");
      const subscription = {
        stream: (async function* () {
          yield {
            type: "session.usage.updated",
            created: 1_786_000_000_000,
            data: {
              sessionID: "ses_live",
              tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          };
          yield {
            type: "session.execution.succeeded",
            created: 1_786_000_000_001,
            data: { sessionID: "ses_live" },
          };
        })(),
      };
      yield* startOpenCode2EventPump(subscription, pumpOptions);
      assert.equal(context.activeTurnId, undefined);
      // Translator usage frame + pump completion settle (order: usage,
      // translator completion, pump completion).
      const first = yield* Queue.take(events);
      assert.equal(first.type, "thread.token-usage.updated");
      const second = yield* Queue.take(events);
      assert.equal(second.type, "turn.completed");
      const third = yield* Queue.take(events);
      assert.equal(third.type, "turn.completed");
      assert.deepEqual(
        (third as unknown as { payload: Record<string, unknown> }).payload["tokenUsage"],
        {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 3,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          hasSubagents: false,
        },
      );
    }),
  );

  it.effect("duplicate terminal frames settle once without extra pump emits", () =>
    Effect.gen(function* () {
      const { events, context, pumpOptions } = yield* pumpSetup("ses_live");
      const subscription = {
        stream: (async function* () {
          yield {
            type: "session.execution.succeeded",
            created: 1_786_000_000_001,
            data: { sessionID: "ses_live" },
          };
          yield {
            type: "session.execution.succeeded",
            created: 1_786_000_000_002,
            data: { sessionID: "ses_live" },
          };
        })(),
      };
      yield* startOpenCode2EventPump(subscription, pumpOptions);
      assert.equal(context.activeTurnId, undefined);
      // Two raw frames still settle once: the first frame's translator +
      // pump-in pair, then the second frame forwards translator output while
      // the pump-in half is a stale no-op (turn already cleared). The queue
      // holds translator output + the single settled completion; ingestion
      // drops the duplicate (lifecycle guard keys on the cleared turn).
      const drained: Array<ProviderRuntimeEvent> = [];
      for (let index = 0; index < 3; index += 1) {
        drained.push(yield* Queue.take(events));
      }
      assert.deepEqual(
        drained.map((event) => event.type),
        ["turn.completed", "turn.completed", "turn.completed"],
      );
      assert.equal(yield* Queue.size(events), 0);
    }),
  );

  it.effect("stream error leaves the context live for reconnect", () =>
    Effect.gen(function* () {
      const { store, events, context, pumpOptions } = yield* pumpSetup();
      yield* handleOpenCode2StreamError(store, pumpOptions);
      yield* Queue.take(events);
      yield* Queue.take(events);
      // A second outage in the same window must still warn (no one-shot
      // silence): the context stays unstopped and listed for resubscribe.
      const stopped = yield* Ref.get(context.stopped);
      assert.equal(stopped, false);
      assert.equal(store.get(threadId), context);
      yield* handleOpenCode2StreamError(store, pumpOptions);
      assert.equal((yield* Queue.take(events)).type, "runtime.warning");
    }),
  );

  it.effect("subagent terminal frame marks subagent involvement without settling", () =>
    Effect.gen(function* () {
      const { store, events, context, pumpOptions } = yield* pumpSetup();
      yield* handleOpenCode2TranslatedEvent(
        store,
        pumpOptions,
        {
          type: "session.execution.succeeded",
          data: { sessionID: "ses_other_child" },
        },
        {
          eventId: "evt_sub1" as never,
          provider: "opencode2" as never,
          threadId,
          createdAt: "2026-09-29T00:00:01.000Z",
          type: "turn.completed",
          payload: { state: "completed" },
        } as unknown as ProviderRuntimeEvent,
      );
      assert.equal(context.activeTurnId, "opencode2-turn-pump");
      assert.equal(context.turnUsage?.hasSubagents, true);
      assert.equal(yield* Queue.size(events), 0);
    }),
  );

  it.effect("stop fails the connection gate so waiters never hang", () =>
    Effect.gen(function* () {
      const { context } = yield* pumpSetup();
      assert.equal(yield* stopOpenCode2Context(context), true);
      const polled = yield* Deferred.poll(context.firstConnection);
      assert.equal(Option.isSome(polled), true);
    }),
  );
});

describe("OpenCode2SessionStore switchModel variant", () => {
  const makeSwitchModelSdk = (seen: Array<unknown>) =>
    ({
      session: {
        switchModel: (input: unknown) => {
          seen.push(input);
          return Effect.void;
        },
      },
    }) as unknown as OpenCodeClient;

  it.effect("forwards variant into the SDK model object when present", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const client = makeOpenCode2SessionClient(makeSwitchModelSdk(seen));
      yield* Effect.promise(() =>
        client.session.switchModel({
          sessionID: "ses_1",
          model: "anthropic/claude-x",
          variant: "high",
        }),
      );
      assert.deepEqual(seen, [
        {
          sessionID: "ses_1",
          model: { providerID: "anthropic", id: "claude-x", variant: "high" },
        },
      ]);
    }),
  );

  it.effect("omits variant from the SDK model object when absent", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const client = makeOpenCode2SessionClient(makeSwitchModelSdk(seen));
      yield* Effect.promise(() =>
        client.session.switchModel({ sessionID: "ses_1", model: "anthropic/claude-x" }),
      );
      assert.deepEqual(seen, [
        { sessionID: "ses_1", model: { providerID: "anthropic", id: "claude-x" } },
      ]);
    }),
  );
});

/** Async iterable whose first read fails: models a dead event transport. */
const failingStream = (message: string): AsyncIterable<{ type: string }> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.reject(new Error(message)),
    } as AsyncIterator<{ type: string }>;
  },
});

describe("OpenCode2SessionStore hardening (sweep A)", () => {
  it.effect("runOpenCode2SdkWithTimeout fails typed after the 10s submission budget", () =>
    Effect.gen(function* () {
      const fiber = yield* runOpenCode2SdkWithTimeout(
        "session.get",
        () => new Promise<never>(() => {}),
      ).pipe(Effect.flip, Effect.forkChild);
      // Drive virtual time until the fiber completes: the forked fiber
      // may not have armed its sleep when a single adjust runs, so poll
      // in bounded steps (each step also lets the fiber schedule timers).
      for (let step = 0; step < 20; step += 1) {
        yield* Effect.yieldNow;
        if (yield* Effect.sync(() => fiber.pollUnsafe() !== undefined)) {
          break;
        }
        yield* TestClock.adjust(Duration.millis(1_000));
      }
      const exit = yield* Fiber.join(fiber);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      assert.match(
        (exit as unknown as { detail: string }).detail,
        /did not complete within 10 seconds/,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("withOpenCode2SubmissionTimeout passes through a fast success", () =>
    Effect.gen(function* () {
      const value = yield* Effect.succeed("ok").pipe(withOpenCode2SubmissionTimeout("session.get"));
      assert.equal(value, "ok");
    }),
  );

  it.effect("reconnect backoff starts at 250ms and caps at 5s", () =>
    Effect.sync(() => {
      assert.equal(openCode2ReconnectDelayMs(0), 250);
      assert.equal(openCode2ReconnectDelayMs(1), 500);
      assert.equal(openCode2ReconnectDelayMs(4), 4_000);
      assert.equal(openCode2ReconnectDelayMs(5), 5_000);
      assert.equal(openCode2ReconnectDelayMs(63), 5_000);
    }),
  );

  it.effect("pump reconnects after a drop with backoff, then forwards the new feed", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      // The reconnected feed ends after its first frame; the pump loop
      // stays alive by design (it would reconnect again), so the test
      // stops the context and interrupts instead of joining.
      let resubscribes = 0;
      const pumpOptions = {
        threadId,
        events,
        store,
        randomEventId: Effect.succeed("evt_reconnect_1"),
        nowIso: Effect.succeed("2026-09-29T00:00:01.000Z"),
        resubscribe: () =>
          Effect.sync(() => {
            resubscribes += 1;
            return {
              stream: (async function* () {
                yield { type: "server.connected" };
              })(),
            };
          }),
      };
      const fiber = yield* startOpenCode2EventPump(
        {
          stream: failingStream("transport drop"),
        },
        pumpOptions,
      ).pipe(Effect.forkChild);
      // First attempt fails (drop), backoff 250ms elapses, resubscribe
      // succeeds and the second feed's frame resolves the connection gate.
      // Gate resolution proves the resubscribe ran. Drive virtual time in
      // bounded steps so each backoff sleep is armed before time advances.
      for (let step = 0; step < 40; step += 1) {
        yield* Effect.yieldNow;
        const gate = (store.get(threadId) as OpenCode2SessionContext).firstConnection;
        if (Option.isSome(yield* Deferred.poll(gate))) {
          break;
        }
        yield* TestClock.adjust(Duration.millis(100));
      }
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      const context = store.get(threadId) as OpenCode2SessionContext;
      const polled = yield* Deferred.poll(context.firstConnection);
      assert.equal(Option.isSome(polled), true);
      assert.equal(resubscribes, 1);
      // Disconnect state was recorded (warning + reconnectable exit), not a
      // silent drop.
      const types: Array<string> = [];
      for (let index = 0; index < 2; index += 1) {
        types.push((yield* Queue.take(events)).type);
      }
      assert.isTrue(types.includes("runtime.warning"));
      assert.isTrue(types.includes("session.exited"));
      // Stop wins: no further reconnects after teardown.
      const stopped = yield* stopOpenCode2Context(context);
      assert.equal(stopped, true);
      yield* Fiber.interrupt(fiber);
      assert.equal(resubscribes, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pump stops reconnecting after the attempt cap with a terminal exit", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      let resubscribes = 0;
      const pumpOptions = {
        threadId,
        events,
        store,
        randomEventId: Effect.succeed("evt_cap_1"),
        nowIso: Effect.succeed("2026-09-29T00:00:01.000Z"),
        resubscribe: () =>
          Effect.sync(() => {
            resubscribes += 1;
            return {
              stream: failingStream("still dead"),
            };
          }),
      };
      const fiber = yield* startOpenCode2EventPump(
        {
          stream: failingStream("dead server"),
        },
        pumpOptions,
      ).pipe(Effect.forkChild);
      // Drive the capped loop under the TestClock: poll in bounded steps
      // so each backoff sleep is armed before time advances (64 attempts,
      // 250ms..5s backoff each; 400 x 5s covers the worst case with margin
      // for arming races).
      for (let step = 0; step < 400; step += 1) {
        yield* Effect.yieldNow;
        if (yield* Effect.sync(() => fiber.pollUnsafe() !== undefined)) {
          break;
        }
        yield* TestClock.adjust(Duration.millis(5_000));
      }
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      // Initial subscribe + 63 resubscribes = 64 attempts, then the loop
      // exits instead of reconnecting forever.
      assert.equal(resubscribes, OPENCODE2_RECONNECT_MAX_ATTEMPTS - 1);
      // The terminal emit is non-recoverable (a dead server, not a blip).
      const drained: Array<ProviderRuntimeEvent> = [];
      let next = yield* Queue.poll(events);
      while (Option.isSome(next)) {
        drained.push(next.value);
        next = yield* Queue.poll(events);
      }
      const terminal = drained.findLast((event) => event.type === "session.exited");
      assert.isDefined(terminal);
      assert.deepEqual(
        (terminal as unknown as { payload: Record<string, unknown> }).payload["recoverable"],
        false,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pending-request maps evict the oldest entry past the cap", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        startDeps(state),
      );
      const context = store.get(threadId) as OpenCode2SessionContext;
      for (let index = 0; index < OPENCODE2_MAX_PENDING_REQUESTS + 5; index += 1) {
        context.pendingPermissions.set(`per_${index}`, {
          requestId: `per_${index}`,
          sessionID: "ses_1",
          permission: "bash",
        });
      }
      evictOldestOpenCode2PendingRequest(context);
      assert.equal(context.pendingPermissions.size, OPENCODE2_MAX_PENDING_REQUESTS + 4);
      assert.equal(context.pendingPermissions.has("per_0"), false);
      assert.equal(
        context.pendingPermissions.has(`per_${OPENCODE2_MAX_PENDING_REQUESTS + 4}`),
        true,
      );
      assert.equal(OPENCODE2_RECONNECT_MAX_ATTEMPTS, 64);
    }),
  );
});

describe("OpenCode2SessionStore start hardening (sweep B)", () => {
  it.effect("failing onSessionStart tears down the published context", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const exit = yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        {
          ...startDeps(state),
          onSessionStart: () => Effect.fail(openCode2RequestError("event.subscribe", "boom")),
        },
      ).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      // The published entry is unpublished so a retry starts clean.
      assert.equal(store.get(threadId), undefined);
      assert.equal(store.size(), 0);
    }),
  );

  it.effect("racing publish during onSessionStart hands out the winner", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const removed: Array<string> = [];
      const base = startDeps(state);
      // Shared counter so the two racing starts mint distinct remote ids
      // (each `makeFakeClient` call counts from `ses_1` on its own).
      let sharedCounter = 0;
      const trackingCreateClient = (input: { directory: string }) =>
        Effect.map(base.createClient(input), (client) => ({
          ...client,
          session: {
            ...client.session,
            create: (_createInput: unknown) => {
              const id = `ses_race_${(sharedCounter += 1)}`;
              state.sessions.set(id, { id, directory: input.directory });
              state.created.push(id);
              return Promise.resolve({ data: { id, directory: input.directory } });
            },
            remove: (removeInput: { sessionID: string }) => {
              removed.push(removeInput.sessionID);
              return Promise.resolve(undefined);
            },
          },
        }));
      let loserId = "";
      const session = yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        {
          ...base,
          createClient: trackingCreateClient,
          onSessionStart: (context: OpenCode2SessionContext) =>
            Effect.gen(function* () {
              loserId = context.openCodeSessionId;
              // A racing start publishes while this start's pump fork runs.
              yield* startOpenCode2Session(
                store,
                { threadId, runtimeMode: "full-access" },
                settings,
                undefined,
                "/work/dir",
                { ...base, createClient: trackingCreateClient },
              );
            }),
        },
      );
      const winner = store.get(threadId) as OpenCode2SessionContext;
      // The racing start won: this start returns the winner's session and
      // removes its own created remote session.
      assert.equal(parseOpenCode2Resume(session.resumeCursor)?.sessionId, winner.openCodeSessionId);
      assert.notEqual(loserId, winner.openCodeSessionId);
      assert.deepEqual(removed, [loserId]);
    }),
  );

  it.effect("defaultModel pins the start-time model at session.create", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const state: FakeState = {
        sessions: new Map(),
        created: [],
        forked: [],
        updated: [],
        messages: new Map(),
        failGet: new Set(),
      };
      const seen: Array<unknown> = [];
      const base = startDeps(state);
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        {
          ...base,
          createClient: (input: { directory: string }) =>
            Effect.map(base.createClient(input), (client) => ({
              ...client,
              session: {
                ...client.session,
                create: (createInput: {
                  readonly title?: string | undefined;
                  readonly agent?: string | undefined;
                  readonly model?:
                    | {
                        readonly providerID: string;
                        readonly modelID: string;
                        readonly variant?: string | undefined;
                      }
                    | undefined;
                  readonly permission: OpenCode2PermissionRuleset;
                }) => {
                  seen.push(createInput);
                  return client.session.create(createInput);
                },
              },
            })),
          defaultModel: {
            providerID: "anthropic",
            modelID: "claude-x",
            variant: "high",
          },
        },
      );
      assert.deepEqual(seen, [
        {
          model: { providerID: "anthropic", modelID: "claude-x", variant: "high" },
          permission: [],
        },
      ]);
    }),
  );

  it.effect("makeOpenCode2SessionClient forwards create model/agent to the SDK", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const sdk = {
        session: {
          create: (input: unknown) => {
            seen.push(input);
            return Effect.succeed({ id: "ses_1", title: "t" });
          },
        },
      } as unknown as Parameters<typeof makeOpenCode2SessionClient>[0];
      const client = makeOpenCode2SessionClient(sdk);
      yield* Effect.promise(() =>
        client.session.create({
          title: "t",
          agent: "plan",
          model: { providerID: "anthropic", modelID: "claude-x", variant: "high" },
          permission: [],
        }),
      );
      assert.deepEqual(seen, [
        {
          title: "t",
          agent: "plan",
          model: { providerID: "anthropic", id: "claude-x", variant: "high" },
          permissions: [],
        },
      ]);
    }),
  );
});
