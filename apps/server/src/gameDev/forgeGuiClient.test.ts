// @effect-diagnostics globalFetch:off - The client is tested against an in-memory MCP server through an injected fetch.
import { describe, expect, it } from "vite-plus/test";

import { ForgeGuiClient, previewUrlOf, publicationStatus, reportedCredits } from "./forgeGuiClient.ts";

/** Speaks MCP Streamable HTTP the way ForgeGUI's hosted server does: JSON or SSE replies and a session id. */
function mockForgeGui() {
  const calls: Array<{ method: string; authorization: string | null; session: string | null }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    calls.push({ method: body.method, authorization: headers.get("authorization"), session: headers.get("mcp-session-id") });
    if (headers.get("authorization") !== "Bearer fg_live_key") return new Response("{}", { status: 401 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const reply = (result: unknown, sse = false) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return sse
        ? new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" } })
        : new Response(payload, { headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
    };
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "forgegui" } }, true);
    if (body.method === "tools/list") return reply({ tools: [{ name: "library_search", description: "Free" }, { name: "generation_gui", description: "Paid" }] });
    if (body.method === "tools/call" && body.params?.name === "generation_gui") {
      return reply({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { job_id: "job-1", status: "succeeded", credits_charged: 4, result: { preview_url: "https://cdn.forgegui.com/previews/job-1.png" } },
      }, true);
    }
    return reply({ content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a1", title: "Gold button" }] }) }] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ForgeGUI client", () => {
  it("initializes, keeps the session, and parses JSON and SSE replies", async () => {
    const mock = mockForgeGui();
    const client = new ForgeGuiClient("fg_live_key", "https://forge.example/mcp", mock.fetchImpl);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["library_search", "generation_gui"]);
    const search = await client.callTool("library_search", { query: "button" });
    expect(search.structured).toEqual({ results: [{ id: "a1", title: "Gold button" }] });
    const generated = await client.callTool("generation_gui", { prompt: "shop panel" });
    expect(reportedCredits(generated.structured)).toEqual({ charged: 4, note: null });
    expect(previewUrlOf(generated.structured)).toBe("https://cdn.forgegui.com/previews/job-1.png");
    expect(mock.calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"]);
    expect(mock.calls.slice(1).every((call) => call.session === "sess-1")).toBe(true);
  });

  it("explains a rejected key without echoing it", async () => {
    const mock = mockForgeGui();
    const client = new ForgeGuiClient("fg_wrong", "https://forge.example/mcp", mock.fetchImpl);
    const error = await client.listTools().catch((caught: Error) => caught);
    expect(String(error)).toContain("rejected the API key");
    expect(String(error)).not.toContain("fg_wrong");
  });

  it("reports credits only when ForgeGUI does, and reads publication status", () => {
    expect(reportedCredits({ billing: "commitDeferred" })).toEqual({ charged: null, note: "ForgeGUI deferred billing and reported no amount." });
    expect(reportedCredits({ error_code: "insufficient_credits" }).note).toContain("out of credits");
    expect(publicationStatus({ delivery: { status: "pending_moderation", roblox_asset_id: 123456, publication_id: "pub-1" } })).toEqual({
      status: "pending_moderation",
      assetId: "123456",
      publicationId: "pub-1",
    });
  });
});
