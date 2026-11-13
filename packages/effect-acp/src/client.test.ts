import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import antigravityInitialize from "../test/fixtures/antigravity-initialize.json" with { type: "json" };
import { DieResponse, ErrorResponse, ExtRequest, ExtResponse, InitializeRequest, InitializeRequestV1, InitializeResponse, InitializeResponseV1, NewSessionRequestV1, PermissionRequest, PermissionResponse, PromptRequest, PromptRequestV1, PromptResponse, PromptResponseV1, SessionUpdateNotification, XAiPromptCompleteNotification, XAiQueueChangedNotification, XAiSessionsChangedNotification, concatBytes, decodePromptRequestLine, decodeWireError, decodeWireResponse, elicitationForm, mockPeerArgs, mockPeerPath, mockStartupNotice, stripMockStartupNotice } from "./client.helpers2.testkit.ts";

it.effect.each(["accept", "decline", "cancel"] as const)(
  "returns a flat %s action to the SDK and preserves the legacy response",
  (action) =>
    Effect.gen(function* () {
      for (const method of ["elicitation/create", "session/elicitation"]) {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const acp = yield* AcpClient.make(stdio);
        const answer = action === "accept" ? { action, content: { choice: "yes" } } : { action };
        const response = { ...answer, _meta: { trace: "fixture" } };
        yield* acp.handleElicitation((request) => {
          assert.deepEqual(request, elicitationForm);
          return Effect.succeed(response);
        });
        yield* Queue.offer(
          input,
          yield* encodeJsonl(jsonRpcRequest(method, AcpSchema.CreateElicitationRequest), {
            jsonrpc: "2.0",
            id: 71,
            headers: [],
            method,
            params: elicitationForm,
          }),
        );
        const received = yield* decodeWireResponse(yield* Queue.take(output));
        assert.deepEqual(received, {
          jsonrpc: "2.0",
          id: 71,
          result:
            method === "elicitation/create" ? response : { action: answer, _meta: response._meta },
        });
      }
    }).pipe(Effect.scoped),
);

it.effect.each(["elicitation/complete", "session/elicitation/complete"])(
  "delivers %s notifications to the completion handler",
  (method) =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      const received = yield* Deferred.make<AcpSchema.CompleteElicitationNotification>();
      yield* acp.handleElicitationComplete((notification) =>
        Deferred.succeed(received, notification).pipe(Effect.asVoid),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcNotification(method, AcpSchema.CompleteElicitationNotification), {
          jsonrpc: "2.0",
          method,
          params: { elicitationId: "elicitation-1" },
        }),
      );
      assert.deepEqual(yield* Deferred.await(received), { elicitationId: "elicitation-1" });
    }).pipe(Effect.scoped),
);

it.effect("rejects malformed SDK elicitation without calling the question handler", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const acp = yield* AcpClient.make(stdio);
    let calls = 0;
    yield* acp.handleElicitation(() => {
      calls++;
      return Effect.succeed({ action: "cancel" as const });
    });
    yield* Queue.offer(
      input,
      yield* encodeJsonl(jsonRpcRequest("elicitation/create", Schema.Unknown), {
        jsonrpc: "2.0",
        id: 73,
        headers: [],
        method: "elicitation/create",
        params: { ...elicitationForm, message: 123 },
      }),
    );
    const response = yield* decodeWireError(yield* Queue.take(output));
    assert.equal(response.error.code, -32602);
    assert.equal(calls, 0);
  }).pipe(Effect.scoped),
);

it.effect("returns method-not-found when SDK elicitation has no question handler", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    yield* AcpClient.make(stdio);
    yield* Queue.offer(
      input,
      yield* encodeJsonl(jsonRpcRequest("elicitation/create", AcpSchema.CreateElicitationRequest), {
        jsonrpc: "2.0",
        id: 74,
        headers: [],
        method: "elicitation/create",
        params: elicitationForm,
      }),
    );
    const response = yield* decodeWireError(yield* Queue.take(output));
    assert.equal(response.error.code, -32601);
  }).pipe(Effect.scoped),
);
