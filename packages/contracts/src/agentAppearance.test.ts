import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { McpGatewayProfile } from "./settings.ts";

const profile = {
  profileId: "write",
  name: "Write",
  revision: 1,
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
};
const decode = Schema.decodeUnknownSync(McpGatewayProfile);
const encode = Schema.encodeSync(McpGatewayProfile);
describe("Agent appearance persistence", () => {
  it("preserves appearance through the wire format and accepts older profiles", () => {
    expect(decode(profile).color).toBeUndefined();
    const styled = decode({ ...profile, color: "#12aBcD", icon: "shield" });
    expect(decode(encode(styled))).toEqual(styled);
    expect(styled).toMatchObject({ color: "#12aBcD", icon: "shield" });
  });
  it("rejects unsupported icons and unsafe CSS values", () => {
    for (const color of ["red", "#123", "url(https://example.com)", "#123456;display:none"]) {
      expect(() => decode({ ...profile, color })).toThrow();
    }
    expect(() => decode({ ...profile, icon: "unknown" })).toThrow();
  });
});
