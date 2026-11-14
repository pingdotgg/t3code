import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Bucket = AWS.S3.Bucket("ExternalHostBucket", { forceDestroy: true });
export const Table = AWS.DynamoDB.Table("ExternalHostTable", {
  partitionKey: "pk",
  attributes: { pk: "S" },
});
export const Queue = AWS.SQS.Queue("ExternalHostQueue");

/**
 * A Cloudflare Worker using AWS bindings: an external host, so each binding
 * grants on the IAM role Alchemy mints for the Worker and signs with its
 * assumed credentials. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the AWS error in the test.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "ExternalHostWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Bucket;
    const table = yield* Table;
    const queue = yield* Queue;

    const putObject = yield* AWS.S3.PutObject(bucket);
    const getObject = yield* AWS.S3.GetObject(bucket);
    const presignGetObject = yield* AWS.S3.PresignGetObject(bucket);
    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const getItem = yield* AWS.DynamoDB.GetItem(table);
    const sendMessage = yield* AWS.SQS.SendMessage(queue);
    const receiveMessage = yield* AWS.SQS.ReceiveMessage(queue);
    const validatePolicy = yield* AWS.AccessAnalyzer.ValidatePolicy();

    const respond = (effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "external-host";
        switch (url.pathname) {
          case "/s3":
            return yield* respond(
              Effect.gen(function* () {
                yield* putObject({ Key: key, Body: "from-worker" });
                const object = yield* getObject({ Key: key });
                return { contentLength: object.ContentLength };
              }),
            );
          case "/s3/presign":
            return yield* respond(
              Effect.gen(function* () {
                yield* putObject({ Key: key, Body: "presigned" });
                return { url: yield* presignGetObject({ key }) };
              }),
            );
          case "/dynamodb":
            return yield* respond(
              Effect.gen(function* () {
                yield* putItem({ Item: { pk: { S: key } } });
                const item = yield* getItem({ Key: { pk: { S: key } }, ConsistentRead: true });
                return { found: item.Item !== undefined };
              }),
            );
          case "/sqs":
            return yield* respond(
              Effect.gen(function* () {
                yield* sendMessage({ MessageBody: key });
                const received = yield* receiveMessage({ WaitTimeSeconds: 5 });
                return { bodies: (received.Messages ?? []).map((message) => message.Body) };
              }),
            );
          case "/access-analyzer":
            return yield* respond(
              validatePolicy({
                policyDocument: JSON.stringify({
                  Version: "2012-10-17",
                  Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
                }),
                policyType: "IDENTITY_POLICY",
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.S3.PutObjectHttp,
        AWS.S3.GetObjectHttp,
        AWS.S3.PresignGetObjectHttp,
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.GetItemHttp,
        AWS.SQS.SendMessageHttp,
        AWS.SQS.ReceiveMessageHttp,
        AWS.AccessAnalyzer.ValidatePolicyHttp,
      ),
    ),
  ),
) {}
