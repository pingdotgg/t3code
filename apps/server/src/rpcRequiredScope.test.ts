import { WsRpcGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RPC_REQUIRED_SCOPE } from "./rpcRequiredScope.ts";

// The RPC dispatch layer in ws.ts throws at runtime when a served method has no
// entry in RPC_REQUIRED_SCOPE. These tests turn that latent runtime failure into
// a test failure: the map must match the set of methods WsRpcGroup actually serves.
describe("RPC_REQUIRED_SCOPE", () => {
  const servedMethods = [...WsRpcGroup.requests.keys()];

  it("declares an authorization scope for every served WsRpcGroup method", () => {
    const missing = servedMethods.filter((method) => !RPC_REQUIRED_SCOPE.has(method));
    expect(missing).toEqual([]);
  });

  it("does not declare scopes for methods that are not served", () => {
    const served = new Set(servedMethods);
    const stale = [...RPC_REQUIRED_SCOPE.keys()].filter((method) => !served.has(method));
    expect(stale).toEqual([]);
  });
});
