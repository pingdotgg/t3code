import { WsRpcGroup } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPE } from "./ws.ts";

/**
 * Regression guard: every RPC method registered in WsRpcGroup must have a
 * declared authorization scope in RPC_REQUIRED_SCOPE. If this test fails it
 * means a new method was added to the RPC group without wiring its scope,
 * which causes ws.ts to throw "no declared authorization scope" on every real
 * call for that method.
 */
it("every WsRpcGroup method has a declared authorization scope in RPC_REQUIRED_SCOPE", () => {
  const missing: string[] = [];
  for (const [methodTag] of WsRpcGroup.requests) {
    if (!RPC_REQUIRED_SCOPE.has(methodTag)) {
      missing.push(methodTag);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `The following WsRpcGroup methods are missing from RPC_REQUIRED_SCOPE:\n  ${missing.join("\n  ")}`,
  );
});
