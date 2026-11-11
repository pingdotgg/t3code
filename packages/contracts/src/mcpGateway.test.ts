import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  GATEWAY_SCOPE_VALUES,
  GATEWAY_SCOPES_BY_ACCESS,
  type GatewayScope,
  McpGatewayConnectInput,
  narrowGatewayScopes,
} from "./mcpGateway.ts";

const decodeConnect = Schema.decodeUnknownExit(McpGatewayConnectInput);

it("accepts only real gateway scopes in a relay registration's grants", () => {
  expect(Exit.isSuccess(decodeConnect({ grants: { remote: ["read", "send"] } }))).toBe(true);
  expect(Exit.isFailure(decodeConnect({ grants: { remote: ["read", "everything"] } }))).toBe(true);
});

const member: ReadonlyArray<GatewayScope> = [
  "read",
  "create",
  "send",
  "control",
  "lifecycle",
  "approval",
  "artifact",
  "delivery",
];

it.each([
  ["read-only", undefined, ["read"]],
  ["approval-required", undefined, member],
  ["auto-accept-edits", undefined, member],
  ["auto", undefined, member],
  ["full-access", undefined, GATEWAY_SCOPE_VALUES],
  ["full-access", ["read", "review"], ["read", "review"]],
  ["auto", ["read", "admin"], ["read"]],
  ["read-only", ["read", "send"], ["read"]],
  ["auto", [], []],
] as const)("%s narrowed to %j grants %j", (access, narrowing, expected) => {
  expect(narrowGatewayScopes(GATEWAY_SCOPES_BY_ACCESS[access], narrowing)).toEqual(expected);
});
