import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { wsRpcProtocolLayer } from "./client.ts";

it.effect("provides a Node WebSocket constructor for the CLI RPC protocol", () =>
  Effect.scoped(
    Layer.build(wsRpcProtocolLayer("ws://127.0.0.1:3100/ws")).pipe(
      Effect.tap(() => Effect.sync(() => assert.isTrue(true))),
    ),
  ),
);
