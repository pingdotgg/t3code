import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { McpGatewayConnectInput } from "./mcpGateway.ts";

const decodeConnect = Schema.decodeUnknownExit(McpGatewayConnectInput);

it("accepts only real gateway scopes in a relay registration's grants", () => {
  expect(Exit.isSuccess(decodeConnect({ grants: { remote: ["read", "send"] } }))).toBe(true);
  expect(Exit.isFailure(decodeConnect({ grants: { remote: ["read", "everything"] } }))).toBe(true);
});
