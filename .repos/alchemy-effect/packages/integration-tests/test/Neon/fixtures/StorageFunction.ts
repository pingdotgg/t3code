import { Function as NeonFunction } from "@alchemy.run/neon/Function";
import { ReadObject } from "@alchemy.run/neon/ReadObject";
import { ReadObjectHttp } from "@alchemy.run/neon/ReadObjectHttp";
import { ReadWriteBucket } from "@alchemy.run/neon/ReadWriteBucket";
import { ReadWriteBucketHttp } from "@alchemy.run/neon/ReadWriteBucketHttp";
import { WriteObject } from "@alchemy.run/neon/WriteObject";
import { WriteObjectHttp } from "@alchemy.run/neon/WriteObjectHttp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { StorageBranch, StorageBucket, StorageSettings } from "./StorageResources.ts";

export default class StorageFunction extends NeonFunction<StorageFunction>()(
  "StorageFunction",
  Effect.gen(function* () {
    return { branch: yield* StorageBranch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const bucket = yield* StorageBucket;
    const object = yield* StorageSettings;
    const files = yield* ReadWriteBucket(bucket);
    const settings = yield* ReadObject(object);
    const writer = yield* WriteObject(object);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url === "/presign") {
          return yield* HttpServerResponse.json({
            url: yield* files.presignPut("signed/spaces & unicode-λ.txt", {
              contentType: "text/plain",
              expiresIn: 60,
            }),
          });
        }
        if (request.url === "/download") {
          return yield* HttpServerResponse.json({
            url: yield* files.presignGet("signed/spaces & unicode-λ.txt", {
              expiresIn: 60,
            }),
          });
        }
        if (request.url === "/write") {
          return yield* writer.put({ theme: "dark", pageSize: 50 }).pipe(
            Effect.as(HttpServerResponse.text("ok")),
            Effect.catch((error) =>
              Effect.succeed(
                HttpServerResponse.text("Storage write failed", {
                  status: 500,
                  headers: { "x-storage-error": error._tag },
                }),
              ),
            ),
          );
        }
        if (request.url === "/invalid") {
          yield* files.put("settings.json", '{"theme":"dark","pageSize":"bad"}', {
            ContentType: "application/json",
          });
          return yield* settings.get().pipe(
            Effect.as(HttpServerResponse.text("accepted", { status: 500 })),
            Effect.catchTag("ObjectDecodeError", () =>
              Effect.succeed(HttpServerResponse.text("rejected")),
            ),
          );
        }
        return yield* HttpServerResponse.json(yield* settings.get());
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Storage request failed", { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(ReadWriteBucketHttp, ReadObjectHttp, WriteObjectHttp))),
) {}
