import * as Lambda from "@/AWS/Lambda";
import * as Transfer from "@/AWS/Transfer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "workflow-handler.ts");

/**
 * Minimal ungated fixture: exercises the account-level
 * `SendWorkflowStepState` binding and the `consumeFileTransferEvents`
 * EventBridge event source without provisioning a (slow, hourly-billed)
 * Transfer server.
 */
export class TransferWorkflowTestFunction extends Lambda.Function<Lambda.Function>()(
  "TransferWorkflowTestFunction",
) {}

export default TransferWorkflowTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to Transfer Family file-transfer
    // events. The deploy proves the EventBridge rule + invoke permission
    // wiring; Transfer publishes to the default bus automatically.
    yield* Transfer.consumeFileTransferEvents(
      { kinds: ["file-upload-completed", "file-upload-failed"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `transfer ${event["detail-type"]}: ${event.detail.username}`,
          ),
        ),
    );

    const sendWorkflowStepState = yield* Transfer.SendWorkflowStepState();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: ["sendWorkflowStepState"],
          });
        }

        // Report a step state against a nonexistent workflow: proves the
        // grant + call round-trips and the rejection is a typed tag.
        if (request.method === "POST" && pathname === "/workflow-step") {
          const sent = yield* sendWorkflowStepState({
            WorkflowId: "w-1234567890abcdef0",
            ExecutionId: "00000000-0000-0000-0000-000000000000",
            Token: "MA==",
            Status: "SUCCESS",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            sent._tag === "Success"
              ? { ok: true }
              : { ok: false, tag: sent.failure._tag },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Lambda.EventSource, Transfer.SendWorkflowStepStateHttp),
    ),
  ),
);
