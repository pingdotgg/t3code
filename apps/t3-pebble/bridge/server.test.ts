import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bridges authorized thread requests and ElevenLabs audio", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3-pebble-test-"));
  const calls: string[] = [];
  const toolArguments: Record<string, unknown>[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/text-to-speech/")) {
      expect(request.headers.get("xi-api-key")).toBe("new-key");
      expect(url.searchParams.get("output_format")).toBe("pcm_8000");
      return new Response(new Uint8Array([1, 2]));
    }
    expect(request.headers.get("authorization")).toBe("Bearer mcp-test");
    const body = await request.json();
    calls.push(body.method === "tools/call" ? body.params.name : body.method);
    if (body.method === "tools/call") toolArguments.push(body.params.arguments);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" }
      : { structuredContent: body.params.name === "t3_thread_list" ? { threads: [{ threadId: "1", title: "Test", projectId: "project" }] }
        : body.params.name === "t3_environment_read" ? { label: "Laptop" }
        : body.params.name === "t3_project_list" ? { projects: [{ id: "project", workspaceRoot: "/code/demo" }], nextCursor: null }
        : body.params.name === "t3_thread_read" ? { thread: { itemCount: 150 }, items: [] } : { runId: "run" } };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "session" } });
  }});
  process.env.T3_MCP_URL = `http://127.0.0.1:${upstream.port}/mcp`;
  process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${upstream.port}`;
  process.env.T3_MCP_TOKEN = "mcp-test"; process.env.T3_PEBBLE_TOKEN = "watch-test";
  process.env.T3_PEBBLE_KEY_PATH = join(temp, "key");
  process.env.ELEVENLABS_API_KEY = "eleven-test"; process.env.T3_PEBBLE_PORT = "0";
  const { server } = await import("./server.ts");
  try {
    const url = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${url}/threads`)).status).toBe(401);
    const headers = { authorization: "Bearer watch-test", "content-type": "application/json" };
    expect((await (await fetch(`${url}/threads`, { headers })).json()).threads[0]).toMatchObject({ title: "Test", machine: "Laptop", directory: "/code/demo" });
    expect((await fetch(`${url}/eleven-key`, { method: "POST", headers, body: JSON.stringify({ key: "new-key" }) })).status).toBe(200);
    expect(await readFile(join(temp, "key"), "utf8")).toBe("new-key");
    expect((await stat(join(temp, "key"))).mode & 0o777).toBe(0o600);
    expect((await fetch(`${url}/read`, { method: "POST", headers, body: JSON.stringify({ threadId: "1" }) })).status).toBe(200);
    expect((await fetch(`${url}/send`, { method: "POST", headers, body: JSON.stringify({ threadId: "1", message: "hello" }) })).status).toBe(200);
    const audio = await fetch(`${url}/speech`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) });
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([1, 2]);
    expect(calls).toEqual(["initialize", "notifications/initialized", "t3_thread_list", "t3_environment_read", "t3_project_list", "t3_thread_read", "t3_thread_read", "t3_thread_send"]);
    expect(toolArguments[4]).toMatchObject({ threadId: "1", afterPosition: 124, maxCharsPerItem: 4000, view: "activity" });
    expect(toolArguments[5]).toMatchObject({ threadId: "1", message: "hello", mode: "queue" });
  } finally { server.stop(true); upstream.stop(true); await rm(temp, { recursive: true, force: true }); }
});
