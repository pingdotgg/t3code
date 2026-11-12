import { ReadBucket } from "@alchemy.run/neon/ReadBucket";
import { ReadBucketHttp } from "@alchemy.run/neon/ReadBucketHttp";
import { ReadWriteBucket } from "@alchemy.run/neon/ReadWriteBucket";
import { ReadWriteBucketHttp } from "@alchemy.run/neon/ReadWriteBucketHttp";
import { StorageBindingError } from "@alchemy.run/neon/StorageBinding";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { StorageBucket } from "./StorageResources.ts";

export const storageHttpHandler = Effect.gen(function* () {
  const bucket = yield* StorageBucket;
  const files = yield* ReadWriteBucket(bucket);
  const reader = yield* ReadBucket(bucket);
  const runtime = yield* CurrentRuntimeContext;
  if (!runtime)
    return yield* Effect.die(
      new StorageBindingError({
        message: "Storage HTTP fixture requires a runtime host",
      }),
    );
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.url.endsWith("/write")) {
        yield* files.put("external.txt", "external roundtrip", {
          ContentType: "text/plain",
        });
        return HttpServerResponse.text("ok");
      }
      const item = yield* reader.head("external.txt");
      return yield* HttpServerResponse.json({
        size: item?.ContentLength,
        hasAccountKey: (yield* runtime.get("NEON_API_KEY")) !== undefined,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Storage request failed", { status: 500 })),
      ),
    ),
  };
}).pipe(Effect.provide(Layer.mergeAll(ReadWriteBucketHttp, ReadBucketHttp)));
