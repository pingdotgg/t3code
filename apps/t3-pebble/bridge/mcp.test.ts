import { expect, test } from "bun:test";
import mcp from "../src/pkjs/mcp.js";
import { installXhr } from "./xhr-shim.ts";

function run<T>(invoke: (callback: (error: Error | null, value: T) => void) => void) {
  return new Promise<T>((resolve, reject) =>
    invoke((error, value) => (error ? reject(error) : resolve(value))),
  );
}

test("initializes lazily, pages project metadata, and calls tools with session headers", async () => {
  const restore = installXhr();
  const calls: string[] = [];
  const projectCursors: unknown[] = [];
  const toolArguments: Record<string, unknown>[] = [];
  const seen: Record<string, string | null>[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      seen.push({
        authorization: request.headers.get("authorization"),
        session: request.headers.get("mcp-session-id"),
        protocol: request.headers.get("mcp-protocol-version"),
      });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      calls.push(body.method === "tools/call" ? body.params.name : body.method);
      if (body.method === "tools/call") toolArguments.push(body.params.arguments);
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : body.params.name === "t3_environment_read"
            ? { label: "Laptop" }
            : body.params.name === "t3_project_list"
              ? (() => {
                  projectCursors.push(body.params.arguments.cursor);
                  const cursor = body.params.arguments.cursor;
                  return cursor === 0
                    ? { projects: [{ id: "a", workspaceRoot: "/code/a" }], nextCursor: 1 }
                    : { projects: [{ id: "b", workspaceRoot: "/code/b" }], nextCursor: null };
                })()
              : body.params.name === "t3_thread_list"
                ? {
                    threads: [
                      {
                        threadId: "1",
                        title: "Test",
                        projectId: "a",
                        providerInstanceId: "codex",
                        updatedAt: new Date(0).toISOString(),
                      },
                    ],
                    nextCursor: null,
                  }
                : body.params.name === "t3_thread_read"
                  ? body.params.arguments.limit === 1
                    ? { thread: { itemCount: 150 }, items: [] }
                    : { items: [{ type: "user_message", text: "hi" }] }
                  : { runId: "run" };
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result },
        { headers: { "mcp-session-id": "session" } },
      );
    },
  });
  try {
    mcp.configure({ origin: `http://127.0.0.1:${upstream.port}`, token: "mcp-test" });
    const page = await run<any>((callback) => mcp.threads(0, callback));
    expect(page.threads[0]).toMatchObject({
      title: "Test",
      machine: "Laptop",
      directory: "/code/a",
    });
    expect(projectCursors).toEqual([0, 1]);
    expect(calls.slice(0, 3)).toEqual(["initialize", "t3_thread_list", "t3_environment_read"]);
    expect(seen[0]).toMatchObject({
      authorization: "Bearer mcp-test",
      session: null,
      protocol: null,
    });
    expect(seen.at(-1)).toMatchObject({ session: "session", protocol: "2025-03-26" });

    await run<any>((callback) => mcp.threads(0, callback));
    expect(calls.filter((name) => name === "t3_environment_read")).toHaveLength(1);

    await run<any>((callback) => mcp.read("1", callback));
    expect(toolArguments.at(-2)).toMatchObject({ threadId: "1", limit: 1 });
    expect(toolArguments.at(-1)).toMatchObject({
      threadId: "1",
      afterPosition: 124,
      maxCharsPerItem: 4000,
      view: "activity",
    });

    await run<any>((callback) => mcp.send("1", "hello", callback));
    expect(toolArguments.at(-1)).toMatchObject({ threadId: "1", message: "hello", mode: "queue" });
  } finally {
    upstream.stop(true);
    restore();
  }
});

test("reads structured results from server-sent events", async () => {
  const restore = installXhr();
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : { structuredContent: { label: "Streamed" } };
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": "stream" },
      });
    },
  });
  try {
    mcp.configure({ origin: `http://127.0.0.1:${upstream.port}`, token: "mcp-test" });
    const value = await run<any>((callback) => mcp.call("t3_environment_read", {}, callback));
    expect(value).toEqual({ label: "Streamed" });
  } finally {
    upstream.stop(true);
    restore();
  }
});

test("resets the session after an HTTP failure and initializes again", async () => {
  const restore = installXhr();
  let initializeCount = 0;
  let fail = true;
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        initializeCount++;
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
          { headers: { "mcp-session-id": "session" } },
        );
      }
      if (fail) return new Response("failed", { status: 500 });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { threads: [] } },
      });
    },
  });
  try {
    mcp.configure({ origin: `http://127.0.0.1:${upstream.port}`, token: "mcp-test" });
    await expect(run<any>((callback) => mcp.threads(0, callback))).rejects.toThrow("HTTP 500");
    fail = false;
    await run<any>((callback) => mcp.threads(0, callback));
    expect(initializeCount).toBe(2);
  } finally {
    upstream.stop(true);
    restore();
  }
});
