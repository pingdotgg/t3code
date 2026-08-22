import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { OPENCODE2_PROVIDER } from "./OpenCode2AdapterV2.ts";
import {
  OPENCODE2_SDK_REPLAY_PROTOCOL,
  OpenCode2ReplayController,
  OpenCode2ReplayMismatchError,
  makeReplayClient,
  type OpenCode2SdkReplayTranscript,
} from "./OpenCode2AdapterV2.testkit.ts";

function transcript(entries: ReadonlyArray<unknown>): OpenCode2SdkReplayTranscript {
  return {
    provider: OPENCODE2_PROVIDER,
    protocol: OPENCODE2_SDK_REPLAY_PROTOCOL,
    version: "test",
    scenario: "replay-controller",
    entries,
  } as unknown as OpenCode2SdkReplayTranscript;
}

describe("OpenCode2AdapterV2 replay testkit", () => {
  it.effect("fails deterministically when an SDK response is exhausted", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(transcript([]));
      const isReplayMismatchError = Schema.is(OpenCode2ReplayMismatchError);
      const exit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => controller.response("session.get"),
          catch: (cause) =>
            isReplayMismatchError(cause)
              ? cause
              : new OpenCode2ReplayMismatchError({
                  scenario: "replay-controller",
                  cursor: 0,
                  expected: { type: "sdk.response", operation: "session.get" },
                  actual: cause,
                }),
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(isReplayMismatchError(Cause.squash(exit.cause)));
      }
    }),
  );

  it.effect("claims distinct delayed responses for concurrent SDK requests", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.get",
              data: { id: "first" },
            },
            afterMs: 1,
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.get",
              data: { id: "second" },
            },
          },
        ]),
      );

      const [first, second] = yield* Effect.promise(() =>
        Promise.all([controller.response("session.get"), controller.response("session.get")]),
      );

      assert.deepStrictEqual(first, { id: "first" });
      assert.deepStrictEqual(second, { id: "second" });
      controller.assertComplete();
    }),
  );

  it.effect("keeps a delayed SDK error claimed until its replay delay elapses", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.error",
              operation: "session.get",
              message: "delayed failure",
            },
            afterMs: 20,
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.get",
              data: { id: "after-error" },
            },
          },
        ]),
      );

      const failure = controller.response("session.get");
      const earlyState = yield* Effect.promise(() =>
        Promise.race([
          failure.then(
            () => "settled",
            () => "settled",
          ),
          Promise.resolve("pending"),
        ]),
      );
      assert.strictEqual(earlyState, "pending");

      const [failed, response] = yield* Effect.promise(() =>
        Promise.all([
          failure.then(
            () => false,
            () => true,
          ),
          controller.response("session.get"),
        ]),
      );
      assert.isTrue(failed);
      assert.deepStrictEqual(response, { id: "after-error" });
      controller.assertComplete();
    }),
  );

  it.effect("claims distinct delayed events for concurrent subscribers", () =>
    Effect.gen(function* () {
      const firstEvent = {
        type: "session.created",
        data: { id: "ses_first" },
      };
      const secondEvent = {
        type: "session.created",
        data: { id: "ses_second" },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: firstEvent },
            afterMs: 1,
          },
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: secondEvent },
          },
          { type: "runtime_exit", status: "success" },
        ]),
      );

      const firstIterator = controller.events()[Symbol.asyncIterator]();
      const secondIterator = controller.events()[Symbol.asyncIterator]();
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([firstIterator.next(), secondIterator.next()]),
      );

      assert.deepStrictEqual(first.value, firstEvent);
      assert.deepStrictEqual(second.value, secondEvent);
      controller.assertComplete();
    }),
  );

  it.effect("holds a prior HTTP error until the confirming event is handled", () =>
    Effect.gen(function* () {
      const replied = {
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "req_1", reply: "once" },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "expect_outbound",
            frame: {
              type: "session.permission.reply",
              input: { sessionID: "ses_1", requestID: "req_1", reply: "once" },
            },
          },
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: replied },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.error",
              operation: "session.permission.reply",
              message: "closed after accept",
            },
          },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const client = makeReplayClient(controller) as unknown as {
        readonly permission: {
          readonly reply: (input: unknown) => Promise<unknown>;
        };
      };
      const iterator = controller.events()[Symbol.asyncIterator]();
      let replySettled = false;
      const reply = client.permission
        .reply({ sessionID: "ses_1", requestID: "req_1", reply: "once" })
        .then(
          () => {
            replySettled = true;
            return "resolved";
          },
          () => {
            replySettled = true;
            return "rejected";
          },
        );

      const event = yield* Effect.promise(() => iterator.next());
      assert.deepStrictEqual(event.value, replied);
      assert.isFalse(replySettled);

      const [status] = yield* Effect.promise(() => Promise.all([reply, iterator.next()]));
      assert.strictEqual(status, "rejected");
      controller.assertComplete();
    }),
  );

  it.effect("lets HTTP started during an event consume the next response", () =>
    Effect.gen(function* () {
      const started = {
        type: "shell.started",
        data: { id: "shl_1" },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: started },
          },
          {
            type: "expect_outbound",
            frame: { type: "shell.output", input: { id: "shl_1" } },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "shell.output",
              data: { output: "ok" },
            },
          },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const client = makeReplayClient(controller) as unknown as {
        readonly shell: {
          readonly output: (input: unknown) => Promise<{ data: { data: unknown } }>;
        };
      };
      const iterator = controller.events()[Symbol.asyncIterator]();
      const event = yield* Effect.promise(() => iterator.next());
      assert.deepStrictEqual(event.value, started);

      const output = yield* Effect.promise(() => client.shell.output({ id: "shl_1" }));
      assert.deepStrictEqual(output.data.data, { output: "ok" });
      yield* Effect.promise(() => iterator.next());
      controller.assertComplete();
    }),
  );

  it.effect("terminates every concurrent subscriber after a successful runtime exit", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(
        transcript([{ type: "runtime_exit", status: "success" }]),
      );
      const first = controller.events()[Symbol.asyncIterator]();
      const second = controller.events()[Symbol.asyncIterator]();

      const results = yield* Effect.promise(() => Promise.all([first.next(), second.next()]));

      assert.isTrue(results[0].done === true);
      assert.isTrue(results[1].done === true);
      controller.assertComplete();
    }),
  );

  it.effect("rejects outbound frames after another replay consumer poisons the controller", () =>
    Effect.gen(function* () {
      const outbound = { type: "session.get", input: { sessionID: "ses_after_failure" } };
      const controller = new OpenCode2ReplayController(
        transcript([
          { type: "runtime_exit", status: "failure" },
          { type: "expect_outbound", frame: outbound },
        ]),
      );
      const iterator = controller.events()[Symbol.asyncIterator]();
      const failure = yield* Effect.promise(() => iterator.next().catch((cause) => cause));
      const outboundFailure = yield* Effect.promise(() =>
        controller.expectOutbound(outbound).catch((cause) => cause),
      );

      assert.strictEqual(outboundFailure, failure);
    }),
  );

  it.effect("delivers a delayed response before the following event", () =>
    Effect.gen(function* () {
      const event = {
        type: "session.created",
        data: { id: "ses_after_response" },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.get",
              data: { id: "response" },
            },
            afterMs: 1,
          },
          { type: "emit_inbound", frame: { type: "sdk.event", event } },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const deliveryOrder: Array<string> = [];
      const iterator = controller.events()[Symbol.asyncIterator]();
      const response = controller.response("session.get").then((value) => {
        deliveryOrder.push("response");
        return value;
      });
      const inbound = iterator.next().then((value) => {
        deliveryOrder.push("event");
        return value;
      });

      const [responseValue, eventValue] = yield* Effect.promise(() =>
        Promise.all([response, inbound]),
      );

      assert.deepStrictEqual(responseValue, { id: "response" });
      assert.deepStrictEqual(eventValue.value, event);
      assert.deepStrictEqual(deliveryOrder, ["response", "event"]);
      controller.assertComplete();
    }),
  );

  it.effect("delivers a delayed event before the following outbound request", () =>
    Effect.gen(function* () {
      const event = {
        type: "session.created",
        data: { id: "ses_before_request" },
      };
      const outbound = { type: "session.get", input: { sessionID: "ses_before_request" } };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event },
            afterMs: 1,
          },
          { type: "expect_outbound", frame: outbound },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const iterator = controller.events()[Symbol.asyncIterator]();
      const inbound = iterator.next();
      const request = controller.expectOutbound(outbound);

      const [eventValue] = yield* Effect.promise(() => Promise.all([inbound, request]));

      assert.deepStrictEqual(eventValue.value, event);
      controller.assertComplete();
    }),
  );

  it.effect("waits for a delayed event before deciding whether a catalog call is recorded", () =>
    Effect.gen(function* () {
      const event = {
        type: "session.created",
        data: { id: "ses_before_catalog" },
      };
      const catalogInput = { location: { directory: "/workspace" } };
      const recordedCatalog = [{ id: "recorded-agent" }];
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event },
            afterMs: 20,
          },
          {
            type: "expect_outbound",
            frame: { type: "agent.list", input: catalogInput },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "agent.list",
              data: recordedCatalog,
            },
          },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const iterator = controller.events()[Symbol.asyncIterator]();
      const inbound = iterator.next();
      const client = makeReplayClient(controller) as unknown as {
        readonly agent: {
          readonly list: (input: unknown) => Promise<{ data: { data: unknown } }>;
        };
      };
      const catalog = client.agent.list(catalogInput);

      const [eventValue, catalogValue] = yield* Effect.promise(() =>
        Promise.all([inbound, catalog]),
      );

      assert.deepStrictEqual(eventValue.value, event);
      assert.deepStrictEqual(catalogValue.data.data, recordedCatalog);
      controller.assertComplete();
    }),
  );

  it.effect("does not consume a delayed event after subscriber abort", () =>
    Effect.gen(function* () {
      const event = {
        type: "session.created",
        data: { id: "ses_replayed" },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event },
            afterMs: 1,
          },
          { type: "runtime_exit", status: "success" },
        ]),
      );
      const abortController = new AbortController();
      const abortedIterator = controller.events(abortController.signal)[Symbol.asyncIterator]();
      const abortedNext = abortedIterator.next();
      const activeIterator = controller.events()[Symbol.asyncIterator]();
      const replayedNext = activeIterator.next();

      abortController.abort();
      const [aborted, replayed] = yield* Effect.promise(() =>
        Promise.all([abortedNext, replayedNext]),
      );
      assert.isTrue(aborted.done === true);
      assert.isFalse(replayed.done === true);
      assert.deepStrictEqual(replayed.value, event);
      controller.assertComplete();
    }),
  );

  it.effect("rejects a response blocked on a nonmatching replay entry after abort", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(
        transcript([{ type: "expect_outbound", frame: { type: "session.create" } }]),
      );
      const pending = controller.response("session.get");

      controller.abort();
      const cause = yield* Effect.promise(() => pending.catch((error) => error));

      assert.match(String(cause), /replay aborted/i);
    }),
  );

  it.effect("rejects delayed and claimed responses after replay abort", () =>
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(
        transcript([
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.get",
              data: { id: "never-delivered" },
            },
            afterMs: 60_000,
          },
        ]),
      );
      const delayed = controller.response("session.get");
      const claimed = controller.response("session.get");

      controller.abort();
      const results = yield* Effect.promise(() => Promise.allSettled([delayed, claimed]));

      assert.strictEqual(results[0]?.status, "rejected");
      assert.strictEqual(results[1]?.status, "rejected");
    }),
  );

  it.effect("routes every adapter replay client operation through the transcript", () =>
    Effect.gen(function* () {
      const agentInput = { location: { directory: "/workspace" } };
      const mcpInput = { location: { directory: "/workspace" } };
      const instructionsInput = {
        sessionID: "ses_1",
        key: "t3-instructions",
        value: { prompt: "Use the T3 tools." },
      };
      const controller = new OpenCode2ReplayController(
        transcript([
          { type: "expect_outbound", frame: { type: "agent.list", input: agentInput } },
          {
            type: "emit_inbound",
            frame: { type: "sdk.response", operation: "agent.list", data: [] },
          },
          { type: "expect_outbound", frame: { type: "mcp.list", input: mcpInput } },
          {
            type: "emit_inbound",
            frame: { type: "sdk.response", operation: "mcp.list", data: [] },
          },
          {
            type: "expect_outbound",
            frame: { type: "session.instructions.entry.put", input: instructionsInput },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.instructions.entry.put",
              data: {},
            },
          },
        ]),
      );
      const client = makeReplayClient(controller);

      yield* Effect.promise(async () => {
        // makeReplayClient is a structural double; cast past Session3 surface.
        const replay = client as unknown as {
          agent: { list: (input: unknown) => Promise<unknown> };
          mcp: { list: (input: unknown) => Promise<unknown> };
          session: {
            instructions: {
              entry: { put: (input: unknown) => Promise<unknown> };
            };
          };
        };
        await replay.agent.list(agentInput);
        await replay.mcp.list(mcpInput);
        await replay.session.instructions.entry.put(instructionsInput);
      });
      controller.assertComplete();
    }),
  );
});
