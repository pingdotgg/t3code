import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";
import { isResource } from "../Resource.ts";
import type { Bucket } from "./Bucket.ts";
import { bindBackendEnvironment } from "./BackendConnection.ts";
import {
  ObjectDecodeError,
  serializeObjectValue,
  storageBodyBytes,
  type Object,
} from "./Object.ts";
import type { ReadObjectClient, ObjectValue } from "./ReadObject.ts";
import type { WriteObjectClient } from "./WriteObject.ts";
import {
  makeStorageBinding,
  StorageBindingError,
  type StorageBindingOptions,
} from "./StorageBinding.ts";

const isBucket = (value: unknown): value is Bucket =>
  isResource(value) && value.Type === "Neon.Bucket";

export const makeReadObjectHttp = () =>
  Effect.gen(function* () {
    const bind = yield* makeStorageBinding("storage:read");
    const runtime = yield* CurrentRuntimeContext;
    if (!runtime)
      return yield* Effect.die(
        new StorageBindingError({
          message: "Object bindings require a Platform host",
        }),
      );
    return Effect.fn(function* <T>(
      object: Object<T>,
      options?: StorageBindingOptions,
    ) {
      const target = object.Props.bucket;
      if (!isBucket(target))
        return yield* Effect.die(
          new StorageBindingError({
            message: "Object bindings require a Neon.Bucket resource reference",
          }),
        );
      const bucket = yield* bind(target, options);
      const name = yield* Effect.sync(
        () =>
          `NEON_OBJECT_${createHash("sha256").update(object.FQN).digest("hex").slice(0, 24).toUpperCase()}_KEY`,
      );
      yield* bindBackendEnvironment(`${object.FQN}:ReadObject`, {
        [name]: object.key,
      });
      const key = runtime.get<string>(name).pipe(
        Effect.flatMap((key) =>
          key === undefined
            ? Effect.fail(
                new StorageBindingError({
                  message: "Object key was not bound",
                }),
              )
            : Effect.succeed(key),
        ),
      );
      const bytes = Effect.gen(function* () {
        const object = yield* bucket.get(yield* key);
        return object ? yield* storageBodyBytes(object.Body) : undefined;
      });
      const get = Effect.gen(function* () {
        const body = yield* bytes;
        if (body === undefined) return undefined;
        if (!("value" in object.Props)) return body as ObjectValue<T>;
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(new TextDecoder().decode(body)),
          catch: () =>
            new ObjectDecodeError({
              message: "Stored object is not valid JSON",
            }),
        });
        if (!object.Props.schema) return parsed as ObjectValue<T>;
        return (yield* Schema.decodeUnknownEffect(object.Props.schema)(
          parsed,
        ).pipe(
          Effect.mapError(
            () =>
              new ObjectDecodeError({
                message: "Stored JSON does not satisfy the object's schema",
              }),
          ),
        )) as ObjectValue<T>;
      });
      return {
        get: () => get,
        bytes: () => bytes,
      } satisfies ReadObjectClient<T>;
    });
  });

export const makeWriteObjectHttp = () =>
  Effect.gen(function* () {
    const bind = yield* makeStorageBinding("storage:write");
    const runtime = yield* CurrentRuntimeContext;
    if (!runtime)
      return yield* Effect.die(
        new StorageBindingError({
          message: "Object bindings require a Platform host",
        }),
      );
    return Effect.fn(function* <T>(
      object: Object<T>,
      options?: StorageBindingOptions,
    ) {
      const target = object.Props.bucket;
      if (!isBucket(target))
        return yield* Effect.die(
          new StorageBindingError({
            message: "Object bindings require a Neon.Bucket resource reference",
          }),
        );
      const bucket = yield* bind(target, options);
      const name = yield* Effect.sync(
        () =>
          `NEON_OBJECT_${createHash("sha256").update(object.FQN).digest("hex").slice(0, 24).toUpperCase()}_KEY`,
      );
      yield* bindBackendEnvironment(`${object.FQN}:WriteObject`, {
        [name]: object.key,
      });
      const put = Effect.fn(function* (
        value: [T] extends [never] ? string | Uint8Array : T,
      ) {
        const key = yield* runtime.get<string>(name);
        if (key === undefined)
          return yield* new StorageBindingError({
            message: "Object key was not bound",
          });
        const observed = yield* bucket.head(key);
        const metadata = {
          ContentType: observed?.ContentType,
          CacheControl: observed?.CacheControl,
          ContentDisposition: observed?.ContentDisposition,
          ContentEncoding: observed?.ContentEncoding,
          Metadata: observed?.Metadata,
        };
        if (!("value" in object.Props)) {
          return yield* bucket.put(key, value as string | Uint8Array, metadata);
        }
        const checked = object.Props.schema
          ? yield* Schema.decodeUnknownEffect(object.Props.schema)(value).pipe(
              Effect.mapError(
                () =>
                  new ObjectDecodeError({
                    message:
                      "Written JSON does not satisfy the object's schema",
                  }),
              ),
            )
          : value;
        return yield* bucket.put(key, yield* serializeObjectValue(checked), {
          ...metadata,
          ContentType: metadata.ContentType ?? "application/json",
        });
      });
      return { put } satisfies WriteObjectClient<T>;
    });
  });
