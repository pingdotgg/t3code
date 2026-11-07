import { describe, expect, it } from "@effect/vitest";
import { matchesResourceUri } from "./resourceUri.ts";

describe("MCP App resource URI matching", () => {
  const uri = "ui://example/dashboard.html";
  const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const route = (value: unknown) => `${uri}?__cf_mcp_server_id=${token(value)}`;
  const envelope = { v: 1, serverId: "example", uri };

  it("accepts exact matches and the portal's verified routing envelope", () => {
    expect(matchesResourceUri(uri, uri)).toBe(true);
    expect(matchesResourceUri(route(envelope), uri)).toBe(true);
  });

  it("preserves the original query encoding and fragment", () => {
    for (const query of ["name=a%20b", "name=~", "name=a+b", "a=1&name=a%20b"]) {
      const original = `${uri}?${query}#section`;
      const routing = token({ ...envelope, uri: original });
      expect(
        matchesResourceUri(`${uri}?${query}&__cf_mcp_server_id=${routing}#section`, original),
      ).toBe(true);
      expect(
        matchesResourceUri(`${uri}?__cf_mcp_server_id=${routing}&${query}#section`, original),
      ).toBe(true);
    }
  });

  it("rejects unrelated resources and malformed or inconsistent routes", () => {
    expect(matchesResourceUri(route(envelope), "ui://other/preview.html")).toBe(false);
    expect(matchesResourceUri(route({ ...envelope, uri: "ui://other/preview.html" }), uri)).toBe(
      false,
    );
    expect(matchesResourceUri(route({ ...envelope, serverId: "" }), uri)).toBe(false);
    expect(matchesResourceUri(`${route(envelope)}&__cf_mcp_server_id=x`, uri)).toBe(false);
    expect(matchesResourceUri(`${uri}?__cf_mcp_server_id=bad`, uri)).toBe(false);
    expect(matchesResourceUri(`${uri}?other=x`, uri)).toBe(false);
  });
});
