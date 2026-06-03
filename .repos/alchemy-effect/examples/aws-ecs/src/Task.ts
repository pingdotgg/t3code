import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { JobsQueue, JobsQueueLive } from "./JobsQueue.ts";

export default class ApiTask extends AWS.ECS.Task<ApiTask>()(
  "ApiTask",
  {
    main: import.meta.filename,
    cpu: 512,
    memory: 1024,
    port: 3000,
  },
  Effect.gen(function* () {
    const queue = yield* JobsQueue;
    const sendMessage = yield* AWS.SQS.SendMessage.bind(queue);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl);
        if (request.method === "GET" && url.pathname === "/") {
          return yield* HttpServerResponse.json({
            ok: true,
            routes: ["GET /", "GET /enqueue?message=hello"],
          });
        }

        if (request.method === "GET" && url.pathname === "/enqueue") {
          const message = url.searchParams.get("message") ?? "hello from ECS";
          const body = JSON.stringify({
            message,
            enqueuedAt: new Date().toISOString(),
          });

          const result = yield* sendMessage({
            MessageBody: body,
          });

          return yield* HttpServerResponse.json({
            ok: true,
            message,
            messageId: result.MessageId,
          });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal server error", { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobsQueueLive,
        AWS.SQS.SendMessageLive,
        AWS.SQS.DeleteMessageBatchLive,
      ),
    ),
  ),
) {}
