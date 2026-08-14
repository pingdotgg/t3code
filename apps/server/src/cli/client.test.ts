import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CliRpcError,
  isDefinitiveCommandRejectionError,
  isDefinitiveCommandRejectionResponse,
  wsRpcProtocolLayer,
} from "./client.ts";

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

it("preserves definitive command rejection as structured CLI error state", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "dispatch rejected",
        definitiveCommandRejection: true,
      }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "ORCHESTRATION_COMMAND_REJECTED: appears only in diagnostics",
      }),
    ),
  );
});
