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
  expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
    AuthOrchestrationReadScope,
  );
  expect(requiredScopeForRpcMethod(WS_METHODS.gitLocalStatus)).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
    AuthOrchestrationReadScope,
  );
  expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
    AuthOrchestrationReadScope,
  );
  expect(requiredScopeForRpcMethod(WS_METHODS.subscribeAuthAccess)).toBe(AuthAccessReadScope);
});

it.effect("rejects RPC methods outside the persisted scope set", () =>
  Effect.gen(function* () {
    yield* authorizeRpcMethod(
      new Set([AuthOrchestrationReadScope]),
      WS_METHODS.serverGetConfig,
      "client",
    );
    const error = yield* Effect.flip(
      authorizeRpcMethod(
        new Set([AuthOrchestrationReadScope]),
        WS_METHODS.serverRefreshProviders,
        "client",
      ),
    );

    expect(error.requiredScope).toBe(AuthOrchestrationOperateScope);
  }),
);

it.effect("restricts host power reports to the local owner session", () =>
  Effect.gen(function* () {
    const scopes = new Set([AuthOrchestrationOperateScope]);
    yield* authorizeRpcMethod(scopes, WS_METHODS.serverReportHostPowerState, "owner");
    const error = yield* Effect.flip(
      authorizeRpcMethod(scopes, WS_METHODS.serverReportHostPowerState, "client"),
    );

    expect(error.message).toContain("local owner session");
  }),
);
