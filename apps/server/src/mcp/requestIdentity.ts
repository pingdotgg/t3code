import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

const encodeParts = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Provider credentials change on restart; the caller's thread owns its retry keys. */
export const requestIdentity = Effect.fn("mcp.requestIdentity")(function* (
  scope: McpInvocationScope,
  operation: string,
  clientRequestId: string,
) {
  const crypto = yield* Digest.Digest;
  const caller =
    scope.thread === undefined
      ? ["client", scope.requestNamespace]
      : ["thread", scope.thread.threadId];
  const encoded = yield* encodeParts([
    scope.environmentId,
    ...caller,
    operation,
    clientRequestId,
  ]).pipe(Effect.orDie);
  return Hex.encode(
    yield* crypto.digest(Digest.sha256, new TextEncoder().encode(encoded)).pipe(Effect.orDie),
  );
});
