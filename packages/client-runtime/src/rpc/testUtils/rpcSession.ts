import * as Effect from "effect/Effect";

import type { WsRpcProtocolClient } from "../protocol.ts";
import type { RpcSession } from "../session.ts";

export interface TestRpcSessionOptions {
  readonly initialConfig?: RpcSession["initialConfig"];
}

/**
 * Keep protocol-only tests insulated from additions to RpcSession.
 *
 * Tests that exercise connection setup should use the real session factory.
 */
export function makeTestRpcSession(
  client: WsRpcProtocolClient,
  options: TestRpcSessionOptions = {},
): RpcSession {
  return {
    client,
    initialConfig: options.initialConfig ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}
