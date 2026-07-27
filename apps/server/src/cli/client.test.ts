import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isDefinitiveCommandRejectionResponse, wsRpcProtocolLayer } from "./client.ts";

it.effect("provides a Node WebSocket constructor for the CLI RPC protocol", () =>
  Effect.scoped(
    Layer.build(wsRpcProtocolLayer("ws://127.0.0.1:3100/ws")).pipe(
      Effect.tap(() => Effect.sync(() => assert.isTrue(true))),
    ),
  ),
);

it("only classifies structured invariant responses as definitive command rejections", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "invariant failed", code: "command-rejected" }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "storage failed", code: "dispatch-failed" }),
    ),
  );
  assert.isFalse(isDefinitiveCommandRejectionResponse("<html>server unavailable</html>"));
});
