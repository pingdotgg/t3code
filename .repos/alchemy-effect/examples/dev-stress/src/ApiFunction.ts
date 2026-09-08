import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as Lambda from "alchemy/AWS/Lambda";
import * as S3 from "alchemy/AWS/S3";
import * as SQS from "alchemy/AWS/SQS";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LAMBDA_MARKER } from "./lambda/marker.ts";

/**
 * The AWS half of the stack: one Lambda owning an S3 bucket, a DynamoDB
 * table, and an SQS queue it also consumes. Under `alchemy dev` all four
 * land in the floci emulator and the function URL is served on
 * `*.lambda-url.us-east-1.localhost:4566`.
 *
 * The stack imports this module (`main: import.meta.url`), so editing it —
 * or `./lambda/marker.ts` — takes the full-restart reload path and the dev
 * provider hot-swaps the function's code inside the emulator.
 *
 * `EchoWorker`'s sibling `ApiWorker` reaches this function URL from local
 * workerd, which is the cross-cloud hop the stress suite pins.
 *
 * Routes:
 *   - `GET  /`               → marker + a `Config`-provided env var
 *   - `GET  /s3`             → PutObject/GetObject roundtrip
 *   - `GET  /dynamo`         → PutItem/GetItem roundtrip
 *   - `POST /queue/send`     → SendMessage over the binding
 *   - `GET  /queue/messages` → what the queue consumer recorded
 */
export default class ApiFunction extends Lambda.Function<ApiFunction>()(
  "ApiFunction",
  {
    main: import.meta.url,
    functionUrl: true,
    memorySize: 512,
    env: { LAMBDA_VARIABLE: "lambda-variable-v1" },
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("StressBucket", { forceDestroy: true });
    const table = yield* DynamoDB.Table("StressTable", {
      partitionKey: "id",
      attributes: { id: "S" },
    });
    const queue = yield* SQS.Queue("StressQueue");

    const getObject = yield* S3.GetObject(bucket);
    const putObject = yield* S3.PutObject(bucket);
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const sendMessage = yield* SQS.SendMessage(queue);
    // <<LAMBDA_BINDINGS>>
    // <</LAMBDA_BINDINGS>>

    // Produce → deliver → consume, so the suite can prove the event-source
    // glue survives every reload it inflicts on the stack.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.mapEffect((record) => {
          const parsed = JSON.parse(record.body) as { id: string };
          return putItem({
            Item: { id: { S: `msg:${parsed.id}` }, body: { S: record.body } },
          });
        }),
        Stream.runDrain,
        Effect.orDie,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (url.pathname === "/") {
          const variable = yield* Config.string("LAMBDA_VARIABLE");
          return yield* HttpServerResponse.json({
            marker: LAMBDA_MARKER,
            variable,
          });
        }

        if (url.pathname === "/s3") {
          yield* putObject({ Key: "hello.txt", Body: "hello from s3" });
          const object = yield* getObject({ Key: "hello.txt" });
          const text = yield* (
            object.Body?.pipe(Stream.decodeText, Stream.mkString) ??
              Effect.succeed("")
          );
          return yield* HttpServerResponse.json({ text });
        }

        if (url.pathname === "/dynamo") {
          yield* putItem({
            Item: { id: { S: "hello" }, content: { S: "hello from dynamo" } },
          });
          const item = yield* getItem({ Key: { id: { S: "hello" } } });
          return yield* HttpServerResponse.json({
            text: item.Item?.content?.S ?? null,
          });
        }

        if (url.pathname === "/queue/send" && request.method === "POST") {
          const body = yield* request.text;
          yield* sendMessage({ MessageBody: body });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (url.pathname === "/queue/messages") {
          const id = url.searchParams.get("id") ?? "";
          const item = yield* getItem({ Key: { id: { S: `msg:${id}` } } });
          return yield* HttpServerResponse.json({
            body: item.Item?.body?.S ?? null,
          });
        }

        // <<LAMBDA_ROUTES>>
        // <</LAMBDA_ROUTES>>

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.QueueEventSource,
        S3.GetObjectHttp,
        S3.PutObjectHttp,
        DynamoDB.GetItemHttp,
        DynamoDB.PutItemHttp,
        SQS.SendMessageHttp,
        // <<LAMBDA_LAYERS>>
        // <</LAMBDA_LAYERS>>
      ),
    ),
  ),
) {}
