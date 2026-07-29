import { describe, expect, it } from "@effect/vitest";

import { buildConnectorUrl, redactConnectorToken } from "./McpConnectorUrl.ts";

const token = "tok-abc123";

describe("buildConnectorUrl", () => {
  it("appends the MCP mount point and the credential to a bare origin", () => {
    expect(buildConnectorUrl({ publicBaseUrl: "https://demo.trycloudflare.com", token })).toBe(
      `https://demo.trycloudflare.com/mcp?k=${token}`,
    );
  });

  it.each([
    "https://demo.trycloudflare.com/",
    "https://demo.trycloudflare.com/mcp",
    "  https://demo.trycloudflare.com  ",
    `https://demo.trycloudflare.com/mcp?k=stale-token`,
  ])("normalises %s to exactly one /mcp with the current token", (publicBaseUrl) => {
    expect(buildConnectorUrl({ publicBaseUrl, token })).toBe(
      `https://demo.trycloudflare.com/mcp?k=${token}`,
    );
  });

  it("preserves a path prefix when the tunnel mounts the server under one", () => {
    expect(buildConnectorUrl({ publicBaseUrl: "https://host.example/sergecode", token })).toBe(
      `https://host.example/sergecode/mcp?k=${token}`,
    );
  });

  it.each(["", "   ", "not a url", "ftp://host/mcp", "http://localhost:8787", "host.example"])(
    "returns undefined for unusable base URL %s",
    (publicBaseUrl) => {
      expect(buildConnectorUrl({ publicBaseUrl, token })).toBeUndefined();
    },
  );

  it("percent-encodes a token so it survives the round trip", () => {
    const url = buildConnectorUrl({ publicBaseUrl: "https://host.example", token: "a+b/c=" });
    expect(url).toBeDefined();
    expect(new URL(url!).searchParams.get("k")).toBe("a+b/c=");
  });
});

describe("redactConnectorToken", () => {
  it("removes the credential from a full URL", () => {
    expect(redactConnectorToken(`https://host.example/mcp?k=${token}`)).toBe(
      "https://host.example/mcp?k=REDACTED",
    );
  });

  it("removes the credential from a bare request line, which is what logs carry", () => {
    // `new URL` cannot parse an origin-relative path, so a parse-based
    // redactor would no-op here and leak the token into the access log.
    expect(redactConnectorToken(`POST /mcp?k=${token} HTTP/1.1`)).toBe(
      "POST /mcp?k=REDACTED HTTP/1.1",
    );
  });

  it("leaves neighbouring parameters intact", () => {
    expect(redactConnectorToken(`/mcp?before=1&k=${token}&after=2`)).toBe(
      "/mcp?before=1&k=REDACTED&after=2",
    );
  });

  it("is a no-op when there is nothing to redact", () => {
    expect(redactConnectorToken("/mcp")).toBe("/mcp");
    expect(redactConnectorToken("/mcp?other=k")).toBe("/mcp?other=k");
  });
});
