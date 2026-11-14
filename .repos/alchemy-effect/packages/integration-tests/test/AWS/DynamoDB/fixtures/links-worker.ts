import * as DynamoDB from "@alchemy.run/aws/DynamoDB";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * A link shortener's storage on DynamoDB, served from a Cloudflare Worker.
 * The Worker reaches AWS through the DynamoDB `*Http` bindings, which mint
 * an IAM identity for it and sign each request with the assumed role.
 */
export const LinksTable = DynamoDB.Table("LinksTable", {
  partitionKey: "id",
  attributes: { id: "S" },
});

export default class LinksWorker extends Cloudflare.Worker<LinksWorker>()(
  "DynamoDBLinksWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const table = yield* LinksTable;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const scan = yield* DynamoDB.Scan(table);
    const batchGetItem = yield* DynamoDB.BatchGetItem(table);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const id = url.pathname.match(/^\/links\/([^/]+)$/)?.[1];

        // PUT /links/:id  body: the target URL
        if (request.method === "PUT" && id) {
          const target = yield* request.text;
          yield* putItem({
            Item: { id: { S: id }, url: { S: target } },
          });
          return yield* HttpServerResponse.json({ id, url: target });
        }

        // GET /links/:id
        if (request.method === "GET" && id) {
          const { Item } = yield* getItem({
            Key: { id: { S: id } },
            ConsistentRead: true,
          });
          return Item
            ? yield* HttpServerResponse.json({ id, url: Item.url?.S })
            : HttpServerResponse.text("Not Found", { status: 404 });
        }

        // GET /links?ids=a,b — one BatchGetItem round trip
        const ids = url.searchParams.get("ids");
        if (request.method === "GET" && url.pathname === "/links" && ids) {
          const { Responses } = yield* batchGetItem({
            // Keyed by logical ID; the binding maps it to the table's physical name.
            RequestItems: {
              LinksTable: {
                Keys: ids.split(",").map((id) => ({ id: { S: id } })),
                ConsistentRead: true,
              },
            },
          });
          return yield* HttpServerResponse.json({
            urls: Object.values(Responses ?? {})
              .flat()
              .map((item) => item?.url?.S)
              .sort(),
          });
        }

        // GET /links
        if (request.method === "GET" && url.pathname === "/links") {
          const { Items } = yield* scan({ ConsistentRead: true });
          return yield* HttpServerResponse.json({
            ids: (Items ?? []).map((item) => item.id?.S).sort(),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        // Surface the failure (e.g. IAM not yet propagated) to the test.
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DynamoDB.GetItemHttp,
        DynamoDB.PutItemHttp,
        DynamoDB.ScanHttp,
        DynamoDB.BatchGetItemHttp,
      ),
    ),
  ),
) {}
