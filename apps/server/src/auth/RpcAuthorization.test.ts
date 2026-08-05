import { expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  authorizeRpcMethod,
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
} from "./RpcAuthorization.ts";

it("declares an authorization scope for every RPC", () => {
  expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
});

it("separates orchestration reads from access-management reads", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.serverGetConfig)).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.subscribeAuthAccess)).toBe(AuthAccessReadScope);
});

it.effect("rejects RPC methods outside the persisted scope set", () =>
  Effect.gen(function* () {
    yield* authorizeRpcMethod(new Set([AuthOrchestrationReadScope]), WS_METHODS.serverGetConfig);
    const error = yield* Effect.flip(
      authorizeRpcMethod(new Set([AuthOrchestrationReadScope]), WS_METHODS.serverRefreshProviders),
    );

    expect(error.requiredScope).toBe(AuthOrchestrationOperateScope);
  }),
);
