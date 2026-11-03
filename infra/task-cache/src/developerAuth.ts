import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Keys = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const decodeKeys = Schema.decodeEffect(Keys);

export const developerIdentity = Effect.fn("TaskCache.developerIdentity")(function* (
  request: Request,
  encodedKeys: string | undefined,
) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("basic ")) return undefined;
  if (!encodedKeys || authorization.length > 1024) return null;

  const decoded = yield* Effect.try(() => atob(authorization.slice(6))).pipe(Effect.option);
  if (decoded._tag === "None") return null;
  const keys = yield* decodeKeys(encodedKeys).pipe(Effect.option);
  if (keys._tag === "None") return null;
  const separator = decoded.value.indexOf(":");
  const name = decoded.value.slice(0, separator);
  const token = decoded.value.slice(separator + 1);
  if (separator < 1 || !/^[a-z0-9-]{1,64}$/.test(name) || token.length < 32) return null;
  const expected = Object.hasOwn(keys.value, name) ? keys.value[name] : undefined;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return null;
  const digest = new Uint8Array(
    yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  );
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0 ? name : null;
});
