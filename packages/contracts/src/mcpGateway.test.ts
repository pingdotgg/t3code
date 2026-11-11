import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { McpGatewayConnectInput } from "./mcpGateway.ts";

const decodeConnect = Schema.decodeUnknownExit(McpGatewayConnectInput);

it("accepts only real gateway scopes in a relay registration's grants", () => {
  expect(Exit.isSuccess(decodeConnect({ grants: { remote: ["read", "send"] } }))).toBe(true);
  expect(Exit.isFailure(decodeConnect({ grants: { remote: ["read", "everything"] } }))).toBe(true);
});

it("refuses a relay registration too large to evaluate on every call", () => {
  const many = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`env-${index}`, ["read"]]));
  expect(Exit.isSuccess(decodeConnect({ grants: many(256) }))).toBe(true);
  expect(Exit.isFailure(decodeConnect({ grants: many(257) }))).toBe(true);
  expect(
    Exit.isFailure(decodeConnect({ grants: { remote: Array.from({ length: 11 }, () => "read") } })),
  ).toBe(true);
});
