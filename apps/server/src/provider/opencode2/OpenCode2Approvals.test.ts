import { describe, it, assert } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  respondToOpenCode2Request,
  respondToOpenCode2UserInput,
  listOpenCode2Descendants,
  trackOpenCode2Permission,
  trackOpenCode2Question,
} from "./OpenCode2Approvals.ts";
import {
  OPENCODE2_MAX_PENDING_REQUESTS,
  makeOpenCode2SessionStore,
  startOpenCode2Session,
  type OpenCode2SessionClient,
} from "./OpenCode2SessionStore.ts";

const threadId = ThreadId.make("thread-oc2-approvals");

interface ApprovalCalls {
  readonly permissionReplies: Array<{ requestID: string; reply: string }>;
  readonly questionReplies: Array<{
    requestID: string;
    answers: ReadonlyArray<ReadonlyArray<string>>;
  }>;
}

const makeClient = (calls: ApprovalCalls): OpenCode2SessionClient => ({
  session: {
    create: () => Promise.resolve({ data: { id: "ses_1", directory: "/work/dir" } }),
    get: () => Promise.reject(Object.assign(new Error("missing"), { status: 404 })),
    list: () => Promise.resolve({ data: [] }),
    fork: () => Promise.resolve({ data: { id: "ses_fork" } }),
    move: () => Promise.resolve({ data: { id: "ses_1" } }),
    wait: () => Promise.resolve(undefined),
    interrupt: () => Promise.resolve(undefined),
    update: () => Promise.resolve(undefined),
    abort: () => Promise.resolve(undefined),
    switchModel: () => Promise.resolve(undefined),
    switchAgent: () => Promise.resolve(undefined),
    promptAsync: () => Promise.resolve(undefined),
    command: () => Promise.resolve(undefined),
    messages: () => Promise.resolve({ data: [] }),
  },
  permission: {
    reply: (input) => {
      calls.permissionReplies.push({ requestID: input.requestID, reply: input.reply });
      return Promise.resolve(undefined);
    },
  },
  question: {
    reply: (input) => {
      calls.questionReplies.push({ requestID: input.requestID, answers: input.answers });
      return Promise.resolve(undefined);
    },
  },
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

const eventDeps = {
  randomEventId: Effect.succeed("evt_1"),
  nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
};

const setup = Effect.gen(function* () {
  const store = makeOpenCode2SessionStore();
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const calls: ApprovalCalls = { permissionReplies: [], questionReplies: [] };
  yield* startOpenCode2Session(
    store,
    { threadId, runtimeMode: "full-access" },
    settings,
    undefined,
    "/work/dir",
    {
      createClient: () => Effect.succeed(makeClient(calls)),
      sameDirectory: (left, right) => Effect.succeed(left === right),
      buildPermissionRules: () => [],
      nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
    },
  );
  return { store, events, calls };
});

describe("OpenCode2Approvals", () => {
  it.effect("replies once to a tracked permission and resolves it", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup;
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_1",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_1"),
        "accept",
        eventDeps,
      );
      assert.deepEqual(calls.permissionReplies, [{ requestID: "req_1", reply: "once" }]);
      const opened = yield* Queue.take(events);
      assert.equal(opened.type, "request.opened");
      // The terminal `request.resolved` arrives via the provider SSE echo
      // (`permission.replied`), not the respond path — so the queue holds no
      // synthetic second event. The id is recorded so a late echo settles
      // state without re-emitting and a re-reply is an idempotent no-op.
      assert.equal(yield* Queue.size(events), 0);
      assert.isTrue(store.get(threadId)?.emittedTerminalRequestIds.has("req_1") ?? false);
      assert.equal(store.get(threadId)?.pendingPermissions.has("req_1"), false);
      // Re-responding after resolution is an idempotent no-op.
      yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_1"),
        "accept",
        eventDeps,
      );
      assert.equal(calls.permissionReplies.length, 1);
    }),
  );

  it.effect("maps acceptForSession to an always reply", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup;
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_2",
          sessionID: "ses_1",
          permission: "edit",
        },
        { requestType: "file_change_approval", eventDeps },
      );
      yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_2"),
        "acceptForSession",
        eventDeps,
      );
      assert.deepEqual(calls.permissionReplies, [{ requestID: "req_2", reply: "always" }]);
    }),
  );

  it.effect("fails typed on unknown permission requests", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      const exit = yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_missing"),
        "decline",
        eventDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("coerces question answers by generated id", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup;
      yield* trackOpenCode2Question(
        store,
        events,
        threadId,
        {
          requestId: "q_1",
          sessionID: "ses_1",
          questions: [{ header: "Pick one", question: "Which?", options: [{ label: "A" }] }],
        },
        eventDeps,
      );
      yield* respondToOpenCode2UserInput(
        store,
        events,
        threadId,
        ApprovalRequestId.make("q_1"),
        { "question-0-pick-one": ["A"] },
        eventDeps,
      );
      assert.deepEqual(calls.questionReplies, [{ requestID: "q_1", answers: [["A"]] }]);
      const requested = yield* Queue.take(events);
      assert.equal(requested.type, "user-input.requested");
      // The terminal `user-input.resolved` arrives via the provider SSE echo
      // (`form.replied`), not the respond path — no synthetic second event.
      assert.equal(yield* Queue.size(events), 0);
      assert.isTrue(store.get(threadId)?.emittedTerminalRequestIds.has("q_1") ?? false);
      assert.equal(store.get(threadId)?.pendingQuestions.has("q_1"), false);
    }),
  );

  it.effect("fails typed on unknown user-input requests", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      const exit = yield* respondToOpenCode2UserInput(
        store,
        events,
        threadId,
        ApprovalRequestId.make("q_missing"),
        {},
        eventDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
    }),
  );
});

describe("OpenCode2Approvals lifecycle fixes", () => {
  it.effect("sends the owning sessionID with permission replies", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      let seen:
        | {
            readonly requestID: string;
            readonly reply: string;
            readonly sessionID?: string | undefined;
          }
        | undefined;
      const context = store.get(threadId);
      assert.isDefined(context);
      const baseClient = context!.client;
      const patchedClient = {
        ...baseClient,
        permission: {
          reply: (input: {
            requestID: string;
            reply: "once" | "always" | "reject";
            sessionID?: string;
          }) => {
            seen = input;
            return Promise.resolve(undefined);
          },
        },
      };
      const patchedContext = { ...context!, client: patchedClient as typeof baseClient };
      store.set(threadId, patchedContext);
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_sid",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_sid"),
        "accept",
        eventDeps,
      );
      assert.deepEqual(seen, { requestID: "req_sid", reply: "once", sessionID: "ses_1" });
    }),
  );

  it.effect("restores the pending permission entry when the reply fails", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup;
      const context = store.get(threadId);
      assert.isDefined(context);
      let fail = true;
      const patchedClient = {
        ...context!.client,
        permission: {
          reply: (input: { requestID: string; reply: string }) => {
            if (fail) {
              return Promise.reject(new Error("transport down"));
            }
            calls.permissionReplies.push({ requestID: input.requestID, reply: input.reply });
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_dead",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      const exit = yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_dead"),
        "accept",
        eventDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      // A transient failure restores the entry so a retry can resubmit
      // instead of stalling on unknown-id; no terminal event was emitted.
      assert.equal(store.get(threadId)?.pendingPermissions.has("req_dead"), true);
      assert.equal(store.get(threadId)?.emittedTerminalRequestIds.has("req_dead"), false);
      fail = false;
      yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_dead"),
        "accept",
        eventDeps,
      );
      assert.deepEqual(calls.permissionReplies, [{ requestID: "req_dead", reply: "once" }]);
      assert.equal(store.get(threadId)?.pendingPermissions.has("req_dead"), false);
      // Drain the opened event so the queue holds no backlog (one track =
      // one event; the failed reply and the retry emit nothing synthetic).
      yield* Queue.take(events);
      assert.equal(yield* Queue.size(events), 0);
    }),
  );

  it.effect("failed permission restore never clobbers a re-registered entry", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      const context = store.get(threadId);
      assert.isDefined(context);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const patchedClient = {
        ...context!.client,
        permission: {
          reply: () => gate.then(() => Promise.reject(new Error("transport down"))),
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_retrack",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      const fiber = yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_retrack"),
        "accept",
        eventDeps,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      // Upstream re-emits the same id while the first reply is in flight;
      // the re-track lands on the evicted map (session ses_2 marks it newer).
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_retrack",
          sessionID: "ses_2",
          permission: "edit",
        },
        { requestType: "file_change_approval", eventDeps },
      );
      release();
      yield* Fiber.join(fiber).pipe(Effect.flip);
      // The failure-path restore must not clobber the re-registered entry.
      const restored = store.get(threadId)?.pendingPermissions.get("req_retrack");
      assert.equal(restored?.sessionID, "ses_2");
      assert.equal(restored?.permission, "edit");
    }),
  );

  it.effect("prefers the v2-native session form reply for user input", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      const formCalls: Array<{ sessionID: string; formID: string; answers: unknown }> = [];
      const questionCalls: Array<unknown> = [];
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        sessionForm: {
          reply: (input: { sessionID: string; formID: string; answers: unknown }) => {
            formCalls.push(input);
            return Promise.resolve(undefined);
          },
        },
        question: {
          reply: (input: unknown) => {
            questionCalls.push(input);
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* trackOpenCode2Question(
        store,
        events,
        threadId,
        {
          requestId: "q_form",
          sessionID: "ses_1",
          questions: [{ header: "Pick one", question: "Which?", options: [{ label: "A" }] }],
        },
        eventDeps,
      );
      yield* respondToOpenCode2UserInput(
        store,
        events,
        threadId,
        ApprovalRequestId.make("q_form"),
        { "question-0-pick-one": ["A"], count: 3, flag: true, skipped: undefined },
        eventDeps,
      );
      assert.equal(formCalls.length, 1);
      assert.deepEqual(formCalls[0], {
        sessionID: "ses_1",
        formID: "q_form",
        answers: { "question-0-pick-one": ["A"], count: 3, flag: true },
      });
      assert.equal(questionCalls.length, 0);
      assert.equal(store.get(threadId)?.pendingQuestions.has("q_form"), false);
    }),
  );

  it.effect("restores the pending question entry when the form reply fails", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      const context = store.get(threadId);
      assert.isDefined(context);
      let attempts = 0;
      const formCalls: Array<{ sessionID: string; formID: string; answers: unknown }> = [];
      const patchedClient = {
        ...context!.client,
        sessionForm: {
          reply: (input: { sessionID: string; formID: string; answers: unknown }) => {
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(new Error("transport down"));
            }
            formCalls.push(input);
            return Promise.resolve(undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* trackOpenCode2Question(
        store,
        events,
        threadId,
        {
          requestId: "q_dead",
          sessionID: "ses_1",
          questions: [{ header: "Pick one", question: "Which?" }],
        },
        eventDeps,
      );
      const exit = yield* respondToOpenCode2UserInput(
        store,
        events,
        threadId,
        ApprovalRequestId.make("q_dead"),
        {},
        eventDeps,
      ).pipe(Effect.flip);
      assert.equal(exit._tag, "ProviderAdapterRequestError");
      assert.equal(store.get(threadId)?.pendingQuestions.has("q_dead"), true);
      // Retry resubmits through the restored entry and succeeds.
      yield* respondToOpenCode2UserInput(
        store,
        events,
        threadId,
        ApprovalRequestId.make("q_dead"),
        {},
        eventDeps,
      );
      assert.equal(formCalls.length, 1);
      assert.equal(store.get(threadId)?.pendingQuestions.has("q_dead"), false);
    }),
  );
});

describe("listOpenCode2Descendants", () => {
  it.effect("walks paginated children breadth-first", () =>
    Effect.gen(function* () {
      const pages: Record<string, Array<{ id: string }>> = {
        "ses_root|cursor:": [{ id: "ses_a" }],
        "ses_root|cursor:page2": [],
        "ses_a|cursor:": [{ id: "ses_leaf" }],
        "ses_a|cursor:page2": [],
        "ses_leaf|cursor:": [],
        "ses_leaf|cursor:page2": [],
      };
      const calls: Array<string> = [];
      const { listOpenCode2Descendants: listDescendants } = yield* Effect.promise(
        () => import("./OpenCode2Approvals.ts"),
      );
      const client = {
        session: {
          children: (input: { sessionID: string; cursor?: string | undefined }) => {
            calls.push(`${input.sessionID}|cursor:${input.cursor ?? ""}`);
            const key = `${input.sessionID}|cursor:${input.cursor ?? ""}`;
            const data = pages[key] ?? [];
            const next = input.cursor === undefined ? "page2" : undefined;
            return Promise.resolve({
              data,
              ...(next !== undefined ? { cursor: { next } } : {}),
            });
          },
        },
      } as unknown as Parameters<typeof listDescendants>[0];
      const descendants = yield* listDescendants(client, "ses_root");
      assert.deepEqual([...descendants].sort(), ["ses_a", "ses_leaf"]);
      // Pagination followed per branch: root and ses_a each list twice.
      assert.isTrue(calls.includes("ses_root|cursor:page2"));
      assert.isTrue(calls.includes("ses_a|cursor:page2"));
    }),
  );

  it.effect("is cycle-safe and tolerates failing branches", () =>
    Effect.gen(function* () {
      const tree: Record<string, Array<string>> = {
        ses_root: ["ses_a", "ses_b"],
        ses_a: ["ses_root", "ses_leaf"],
        ses_b: [],
      };
      const client = {
        session: {
          children: (input: { sessionID: string }) => {
            if (input.sessionID === "ses_b") {
              return Promise.reject(new Error("listing exploded"));
            }
            return Promise.resolve({
              data: (tree[input.sessionID] ?? []).map((id) => ({ id })),
            });
          },
        },
      } as unknown as Parameters<typeof listOpenCode2Descendants>[0];
      const descendants = yield* listOpenCode2Descendants(client, "ses_root");
      // The root never reappears (visited-set) and the failing branch
      // contributes nothing instead of failing the walk.
      assert.deepEqual([...descendants].sort(), ["ses_a", "ses_b", "ses_leaf"]);
    }),
  );

  it.effect("returns only the root when the binding predates children", () =>
    Effect.gen(function* () {
      const client = {
        session: {},
      } as unknown as Parameters<typeof listOpenCode2Descendants>[0];
      const descendants = yield* listOpenCode2Descendants(client, "ses_root");
      assert.deepEqual([...descendants], []);
    }),
  );
});

describe("OpenCode2Approvals hardening (sweep A)", () => {
  it.effect("permission reply carries the 10s submission budget", () =>
    Effect.gen(function* () {
      const store = makeOpenCode2SessionStore();
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const hanging = {
        session: {
          create: () => Promise.resolve({ data: { id: "ses_1", directory: "/work/dir" } }),
          get: () => Promise.reject(Object.assign(new Error("missing"), { status: 404 })),
          list: () => Promise.resolve({ data: [] }),
          fork: () => Promise.resolve({ data: { id: "ses_fork" } }),
          move: () => Promise.resolve({ data: { id: "ses_1" } }),
          wait: () => Promise.resolve(undefined),
          interrupt: () => Promise.resolve(undefined),
          update: () => Promise.resolve(undefined),
          abort: () => Promise.resolve(undefined),
          switchModel: () => Promise.resolve(undefined),
          switchAgent: () => Promise.resolve(undefined),
          promptAsync: () => Promise.resolve(undefined),
          command: () => Promise.resolve(undefined),
          messages: () => Promise.resolve({ data: [] }),
        },
        permission: { reply: () => new Promise<never>(() => {}) },
        question: { reply: () => Promise.resolve(undefined) },
        event: {
          subscribe: () =>
            Promise.resolve({
              stream: (async function* () {
                yield { type: "server.connected" };
              })(),
            }),
        },
      } as unknown as OpenCode2SessionClient;
      yield* startOpenCode2Session(
        store,
        { threadId, runtimeMode: "full-access" },
        settings,
        undefined,
        "/work/dir",
        {
          createClient: () => Effect.succeed(hanging),
          sameDirectory: (left, right) => Effect.succeed(left === right),
          buildPermissionRules: () => [],
          nowIso: Effect.succeed("2026-09-29T00:00:00.000Z"),
        },
      );
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_hang",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      // The hanging reply must trip the 10s budget on virtual time, not
      // hang the suite; the pending entry restores so a retry stays possible.
      const fiber = yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_hang"),
        "accept",
        eventDeps,
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
      assert.equal(store.get(threadId)?.pendingPermissions.has("req_hang"), true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("descendant walk caps depth at 32", () =>
    Effect.gen(function* () {
      // Linear chain 40 deep: the walk must stop at maxDepth 32.
      const { listOpenCode2Descendants: listDescendants } = yield* Effect.promise(
        () => import("./OpenCode2Approvals.ts"),
      );
      const client = {
        session: {
          children: (input: { sessionID: string }) => {
            const index = Number(input.sessionID.split("_")[1]);
            if (Number.isNaN(index) || index >= 39) {
              return Promise.resolve({ data: [] });
            }
            return Promise.resolve({ data: [{ id: `ses_${index + 1}` }] });
          },
        },
      } as unknown as Parameters<typeof listDescendants>[0];
      const descendants = yield* listDescendants(client, "ses_0");
      assert.equal(descendants.length, 32);
      assert.equal(descendants[31], "ses_32");
    }),
  );

  it.effect("descendant walk ends on a repeated page cursor", () =>
    Effect.gen(function* () {
      const { listOpenCode2Descendants: listDescendants } = yield* Effect.promise(
        () => import("./OpenCode2Approvals.ts"),
      );
      // Only the root has children; every other branch is a leaf. The
      // root's listing echoes the same cursor forever: the guard ends the
      // branch after the first repeat instead of paging forever.
      let calls = 0;
      const client = {
        session: {
          children: (input: { sessionID: string }) => {
            if (input.sessionID !== "ses_root") {
              return Promise.resolve({ data: [] });
            }
            calls += 1;
            return Promise.resolve({
              data: calls === 1 ? [{ id: "ses_leaf" }] : [],
              cursor: { next: "stuck" },
            });
          },
        },
      } as unknown as Parameters<typeof listDescendants>[0];
      const descendants = yield* listDescendants(client, "ses_root");
      // First page + repeated-cursor page, then the guard ends the branch.
      assert.equal(calls, 2);
      assert.deepEqual([...descendants], ["ses_leaf"]);
    }),
  );

  it.effect("concurrent replies for the same request submit only once", () =>
    Effect.gen(function* () {
      const { store, events, calls } = yield* setup;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const context = store.get(threadId);
      assert.isDefined(context);
      const patchedClient = {
        ...context!.client,
        permission: {
          reply: (input: { requestID: string; reply: string }) => {
            calls.permissionReplies.push({ requestID: input.requestID, reply: input.reply });
            return gate.then(() => undefined);
          },
        },
      };
      store.set(threadId, { ...context!, client: patchedClient });
      yield* trackOpenCode2Permission(
        store,
        events,
        threadId,
        {
          requestId: "req_race",
          sessionID: "ses_1",
          permission: "bash",
        },
        { requestType: "command_execution_approval", eventDeps },
      );
      // Both fibers race the same pending id: the first claims it before its
      // SDK await, so the second finds no entry and fails typed unknown-id
      // (the id is not terminal yet). Either way it must not submit a
      // second reply.
      const first = yield* respondToOpenCode2Request(
        store,
        events,
        threadId,
        ApprovalRequestId.make("req_race"),
        "accept",
        eventDeps,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const secondExit = yield* Effect.exit(
        respondToOpenCode2Request(
          store,
          events,
          threadId,
          ApprovalRequestId.make("req_race"),
          "decline",
          eventDeps,
        ),
      );
      release();
      yield* Fiber.join(first);
      assert.equal(calls.permissionReplies.length, 1);
      assert.deepEqual(calls.permissionReplies[0], { requestID: "req_race", reply: "once" });
      assert.isTrue(Exit.isFailure(secondExit));
      if (Exit.isFailure(secondExit)) {
        const failure = Cause.squash(secondExit.cause);
        assert.equal((failure as { readonly _tag?: string })._tag, "ProviderAdapterRequestError");
      }
      // Drain the opened event so the queue holds no backlog.
      yield* Queue.take(events);
      assert.equal(yield* Queue.size(events), 0);
    }),
  );

  it.effect("tracked approvals evict the oldest entry past the cap", () =>
    Effect.gen(function* () {
      const { store, events } = yield* setup;
      for (let index = 0; index < OPENCODE2_MAX_PENDING_REQUESTS + 1; index += 1) {
        yield* trackOpenCode2Permission(
          store,
          events,
          threadId,
          {
            requestId: `req_${index}`,
            sessionID: "ses_1",
            permission: "bash",
          },
          { requestType: "command_execution_approval", eventDeps },
        );
      }
      const context = store.get(threadId);
      assert.isDefined(context);
      assert.equal(
        context!.pendingPermissions.size + context!.pendingQuestions.size,
        OPENCODE2_MAX_PENDING_REQUESTS,
      );
      assert.equal(context!.pendingPermissions.has("req_0"), false);
      // Drain the opened events so the queue holds no unbounded backlog.
      for (let index = 0; index < OPENCODE2_MAX_PENDING_REQUESTS + 1; index += 1) {
        yield* Queue.take(events);
      }
      assert.equal(yield* Queue.size(events), 0);
    }),
  );
});
