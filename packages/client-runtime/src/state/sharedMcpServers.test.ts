import { describe, expect, it } from "vite-plus/test";

import {
  parseSharedMcpServerDraft,
  sharedMcpServerDraft,
  upsertSharedMcpServer,
} from "./sharedMcpServers.ts";

const gateway = {
  name: "gateway",
  url: "http://127.0.0.1:3050/mcp",
  enabled: false,
  headers: { Authorization: "••••••" },
};

describe("parseSharedMcpServerDraft", () => {
  it("trims fields and parses one header per line", () => {
    expect(
      parseSharedMcpServerDraft([], {
        name: " docs ",
        url: " https://mcp.example.com ",
        headers: "Authorization: Bearer abc\n\nX-Api-Key:k:1",
      }),
    ).toMatchObject({
      server: {
        name: "docs",
        url: "https://mcp.example.com",
        enabled: true,
        headers: { Authorization: "Bearer abc", "X-Api-Key": "k:1" },
      },
    });
  });

  it("rejects names agents can't use, duplicates, bad headers, and non-http URLs", () => {
    const draft = { name: "docs", url: "http://x", headers: "" };
    expect(parseSharedMcpServerDraft([], { ...draft, name: "my server" })).toHaveProperty("error");
    expect(parseSharedMcpServerDraft([], { ...draft, name: "t3-code" })).toHaveProperty("error");
    expect(parseSharedMcpServerDraft([], { ...draft, name: "x".repeat(25) })).toHaveProperty(
      "error",
    );
    expect(parseSharedMcpServerDraft([gateway], { ...draft, name: "gateway" })).toHaveProperty(
      "error",
    );
    expect(parseSharedMcpServerDraft([], { ...draft, headers: "no separator" })).toHaveProperty(
      "error",
    );
    expect(
      parseSharedMcpServerDraft([], { ...draft, headers: "Authorization: a\nauthorization: b" }),
    ).toHaveProperty("error");
    expect(parseSharedMcpServerDraft([], { ...draft, url: "npx some-server" })).toHaveProperty(
      "error",
    );
  });

  it("gives a new server an id and keeps a saved server's key through a rename", () => {
    expect(
      parseSharedMcpServerDraft([], { name: "docs", url: "http://x", headers: "" }),
    ).toMatchObject({ server: { id: "docs" } });
    // `gateway` was renamed to `gw` but still owns the `gateway` key.
    const renamedGateway = { ...gateway, id: "gateway", name: "gw" };
    expect(
      parseSharedMcpServerDraft([renamedGateway], {
        name: "gateway",
        url: "http://x",
        headers: "",
      }),
    ).toMatchObject({ server: { id: "gateway-2", name: "gateway" } });

    // An entry saved without an id keeps its name as the key, so its secrets follow it.
    const renamed = parseSharedMcpServerDraft(
      [gateway],
      { ...sharedMcpServerDraft(gateway), name: "gw" },
      gateway,
    );
    expect(renamed).toMatchObject({ server: { id: "gateway", name: "gw" } });
  });

  it("edits a saved server in place, keeping its switch and redacted header", () => {
    const parsed = parseSharedMcpServerDraft(
      [gateway],
      { ...sharedMcpServerDraft(gateway), url: "http://127.0.0.1:4000/mcp" },
      gateway,
    );
    expect(parsed).toEqual({
      server: { ...gateway, id: "gateway", url: "http://127.0.0.1:4000/mcp" },
    });
    if (!("server" in parsed)) return;
    expect(upsertSharedMcpServer([gateway], parsed.server, gateway)).toEqual([parsed.server]);
  });
});
