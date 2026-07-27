import * as CloudFront from "@/AWS/CloudFront";
import * as Lambda from "@/AWS/Lambda";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "kvs-handler.ts");

export class CloudFrontKvsTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudFrontKvsTestFunction",
) {}

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

export default CloudFrontKvsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const store = yield* CloudFront.KeyValueStore("BindingsKvStore", {
      // Deterministic marker so the test can find this store out-of-band
      // via listKeyValueStores.
      comment: "alchemy-cf-kvs-bindings-fixture",
    });

    const describeStore = yield* CloudFront.DescribeKeyValueStore(store);
    const getKey = yield* CloudFront.GetKey(store);
    const listKeys = yield* CloudFront.ListKeys(store);
    const putKey = yield* CloudFront.PutKey(store);
    const deleteKey = yield* CloudFront.DeleteKey(store);
    const updateKeys = yield* CloudFront.UpdateKeys(store);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const meta = yield* describeStore({});
          return yield* HttpServerResponse.json({
            etag: meta.ETag,
            itemCount: meta.ItemCount,
            status: meta.Status,
            kvsArn: meta.KvsARN,
          });
        }

        if (request.method === "GET" && pathname === "/key") {
          const key = url.searchParams.get("key")!;
          const res = yield* getKey({ Key: key });
          return yield* HttpServerResponse.json({
            key: res.Key,
            value: unwrap(res.Value),
          });
        }

        if (request.method === "GET" && pathname === "/keys") {
          const res = yield* listKeys({});
          return yield* HttpServerResponse.json({
            keys: (res.Items ?? []).map((item) => ({
              key: item.Key,
              value: unwrap(item.Value),
            })),
          });
        }

        if (request.method === "POST" && pathname === "/put") {
          const body = (yield* request.json) as unknown as {
            key: string;
            value: string;
          };
          const meta = yield* describeStore({});
          const res = yield* putKey({
            Key: body.key,
            Value: body.value,
            IfMatch: meta.ETag,
          });
          return yield* HttpServerResponse.json({
            etag: res.ETag,
            itemCount: res.ItemCount,
          });
        }

        if (request.method === "POST" && pathname === "/update") {
          const body = (yield* request.json) as unknown as {
            puts?: { key: string; value: string }[];
            deletes?: { key: string }[];
          };
          const meta = yield* describeStore({});
          const res = yield* updateKeys({
            IfMatch: meta.ETag,
            Puts: body.puts?.map((p) => ({ Key: p.key, Value: p.value })),
            Deletes: body.deletes?.map((d) => ({ Key: d.key })),
          });
          return yield* HttpServerResponse.json({
            etag: res.ETag,
            itemCount: res.ItemCount,
          });
        }

        if (request.method === "POST" && pathname === "/delete") {
          const body = (yield* request.json) as unknown as { key: string };
          const meta = yield* describeStore({});
          const res = yield* deleteKey({
            Key: body.key,
            IfMatch: meta.ETag,
          });
          return yield* HttpServerResponse.json({
            etag: res.ETag,
            itemCount: res.ItemCount,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudFront.DescribeKeyValueStoreHttp,
        CloudFront.GetKeyHttp,
        CloudFront.ListKeysHttp,
        CloudFront.PutKeyHttp,
        CloudFront.DeleteKeyHttp,
        CloudFront.UpdateKeysHttp,
      ),
    ),
  ),
);
