import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as Lambda from "alchemy/AWS/Lambda";
import * as S3 from "alchemy/AWS/S3";
import * as SNS from "alchemy/AWS/SNS";
import * as SQS from "alchemy/AWS/SQS";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MARKER } from "./marker.ts";

/**
 * Kitchen-sink dev-mode Lambda: one Function owning an S3 bucket, a
 * DynamoDB table, an SQS queue, and an SNS topic, exercising each runtime
 * binding AND each event-source glue resource (Subscription, Permission,
 * EventSourceMapping) over HTTP routes so `alchemy dev` — and a live
 * `alchemy deploy` — can be driven end-to-end from a test.
 *
 * Routes:
 *   - GET  /                  → marker + env (Config-provided MY_VARIABLE)
 *   - GET  /s3                → PutObject/GetObject roundtrip
 *   - GET  /dynamo            → PutItem/GetItem roundtrip
 *   - POST /queue/send        → SendMessage over the binding
 *   - GET  /queue/messages    → reads what the queue consumer recorded
 *   - POST /topic/send        → SNS Publish over the binding
 *   - GET  /topic/messages    → reads what the topic consumer recorded
 *   - POST /items             → PutItem with a caller-chosen id (stream feed)
 *   - GET  /changes           → reads what the table-changes consumer recorded
 *
 * The consumers all run on this same Function:
 *   - `consumeQueueMessages` — the event-source-mapping poller invokes it
 *     with SQS batches
 *   - `consumeTopicNotifications` — creates the SNS.Subscription and the
 *     Lambda invoke Permission (the glue that must be local in dev mode)
 *   - `consumeTableChanges` — enables the table stream and creates the
 *     stream EventSourceMapping
 * Each consumer records into the table under a distinct key prefix so every
 * produce → deliver → consume path is observable over HTTP.
 */
export default class ApiFunction extends Lambda.Function<ApiFunction>()(
  "ApiFunction",
  {
    main: import.meta.url,
    functionUrl: true,
    // The default 128 MB runs this fixture at its ceiling (observed
    // Max Memory Used: 127 MB live) — leave headroom for event batches.
    memorySize: 512,
    env: { MY_VARIABLE: "my-variable-abc123" },
  },
  Effect.gen(function* () {
    // `/s3` writes into the bucket, so destroy must empty it first.
    const bucket = yield* S3.Bucket("DevBucket", { forceDestroy: true });
    const table = yield* DynamoDB.Table("MessagesTable", {
      partitionKey: "id",
      attributes: { id: "S" },
    });
    const queue = yield* SQS.Queue("DevQueue");
    const topic = yield* SNS.Topic("DevTopic");

    const getObject = yield* S3.GetObject(bucket);
    const putObject = yield* S3.PutObject(bucket);
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const sendMessage = yield* SQS.SendMessage(queue);
    const publish = yield* SNS.Publish(topic);

    // Consume produced messages and record them into the table so the
    // test can observe the produce → deliver → consume roundtrip.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.mapEffect((record) => {
          const parsed = JSON.parse(record.body) as { id: string };
          return putItem({
            Item: {
              id: { S: `msg:${parsed.id}` },
              body: { S: record.body },
            },
          });
        }),
        Stream.runDrain,
        Effect.orDie,
      ),
    );

    // Consume topic notifications. This is the SNS → Lambda glue: it
    // creates the AWS.SNS.Subscription and the AWS.Lambda.Permission
    // (lambda:InvokeFunction for sns.amazonaws.com) — the two resources
    // that MUST resolve against the emulator in dev mode, since their
    // props embed the local topic/function ARNs.
    yield* SNS.consumeTopicNotifications(topic, (notifications) =>
      notifications.pipe(
        Stream.mapEffect((notification) => {
          const parsed = JSON.parse(notification.Message) as { id: string };
          return putItem({
            Item: {
              id: { S: `topic:${parsed.id}` },
              body: { S: notification.Message },
            },
          });
        }),
        Stream.runDrain,
        Effect.orDie,
      ),
    );

    // Consume the table's change stream. This enables the DynamoDB stream
    // on the table and creates the stream AWS.Lambda.EventSourceMapping.
    // Only plain (un-prefixed) item ids are recorded, so the consumers'
    // own `msg:`/`topic:`/`change:` writes never feed back into the stream.
    // TRIM_HORIZON, not LATEST: on real AWS the poller starts reading from
    // the stream TIP whenever it actually begins polling (minutes after
    // mapping creation), so LATEST permanently skips records written in
    // that window — a write shortly after deploy would never arrive.
    yield* DynamoDB.consumeTableChanges(
      table,
      {
        streamViewType: "NEW_AND_OLD_IMAGES",
        startingPosition: "TRIM_HORIZON",
      },
      (changes) =>
        changes.pipe(
          Stream.mapEffect((record) => {
            const id = record.dynamodb.Keys?.id?.S;
            if (typeof id !== "string" || id.includes(":")) {
              return Effect.void;
            }
            return putItem({
              Item: {
                id: { S: `change:${id}` },
                body: { S: record.eventName ?? "UNKNOWN" },
              },
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
          const variable = yield* Config.string("MY_VARIABLE");
          return yield* HttpServerResponse.json({ marker: MARKER, variable });
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
            Item: {
              id: { S: "hello" },
              content: { S: "hello from dynamo" },
            },
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

        if (url.pathname === "/topic/send" && request.method === "POST") {
          const body = yield* request.text;
          yield* publish({ Message: body });
          return yield* HttpServerResponse.json({ published: true });
        }

        if (url.pathname === "/topic/messages") {
          const id = url.searchParams.get("id") ?? "";
          const item = yield* getItem({ Key: { id: { S: `topic:${id}` } } });
          return yield* HttpServerResponse.json({
            body: item.Item?.body?.S ?? null,
          });
        }

        if (url.pathname === "/items" && request.method === "POST") {
          const body = yield* request.text;
          const parsed = JSON.parse(body) as { id: string };
          yield* putItem({
            Item: {
              id: { S: parsed.id },
              body: { S: body },
            },
          });
          return yield* HttpServerResponse.json({ put: true });
        }

        if (url.pathname === "/changes") {
          const id = url.searchParams.get("id") ?? "";
          const item = yield* getItem({ Key: { id: { S: `change:${id}` } } });
          return yield* HttpServerResponse.json({
            body: item.Item?.body?.S ?? null,
          });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.QueueEventSource,
        Lambda.TopicEventSource,
        Lambda.TableEventSource,
        S3.GetObjectHttp,
        S3.PutObjectHttp,
        DynamoDB.GetItemHttp,
        DynamoDB.PutItemHttp,
        SQS.SendMessageHttp,
        SNS.PublishHttp,
      ),
    ),
  ),
) {}
