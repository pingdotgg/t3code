// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  MCP_STDIO_BRIDGE_FILE_NAME,
  MCP_STDIO_BRIDGE_SOURCE,
  mcpStdioBridgeEntry,
} from "./McpStdioBridge.ts";

interface SeenRequest {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly protocolVersion: string | undefined;
  readonly authorization: string | undefined;
}

describe("McpStdioBridge", () => {
  it("builds a stdio MCP entry that launches the bridge under the current runtime", () => {
    const entry = mcpStdioBridgeEntry({
      bridgePath: "/tmp/state/mcp-stdio-bridge.mjs",
      endpoint: "http://127.0.0.1:9/mcp",
      authorizationHeader: "Bearer test",
    });
    expect(entry).toEqual({
      name: "t3-code",
      command: process.execPath,
      args: ["/tmp/state/mcp-stdio-bridge.mjs"],
      env: [
        { name: "T3_MCP_ENDPOINT", value: "http://127.0.0.1:9/mcp" },
        { name: "T3_MCP_AUTHORIZATION", value: "Bearer test" },
      ],
    });
  });

  it("relays stdio JSON-RPC to the streamable-HTTP endpoint and preserves session headers", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-bridge-"));
    const bridgePath = NodePath.join(dir, MCP_STDIO_BRIDGE_FILE_NAME);
    await NodeFSP.writeFile(bridgePath, MCP_STDIO_BRIDGE_SOURCE);

    const seen: SeenRequest[] = [];
    const server = NodeHttp.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { id?: number; method?: string };
        seen.push({
          method: parsed.method ?? "",
          sessionId: req.headers["mcp-session-id"] as string | undefined,
          protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
          authorization: req.headers.authorization,
        });
        switch (parsed.method) {
          case "initialize":
            res.writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "stub-session-1",
              "mcp-protocol-version": "2025-06-18",
            });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { protocolVersion: "2025-06-18" },
              }),
            );
            return;
          case "tools/list":
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { tools: [{ name: "link_pull_request" }] },
              }),
            );
            return;
          case "tools/call":
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
              `data: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } })}\n\n`,
            );
            return;
          case "boom/fail":
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("upstream exploded");
            return;
          case "boom/json":
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_mcp_credential" }));
            return;
          default:
            res.writeHead(202);
            res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server missing address");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;

    const child = NodeChildProcess.spawn(process.execPath, [bridgePath], {
      env: { T3_MCP_ENDPOINT: endpoint, T3_MCP_AUTHORIZATION: "Bearer test-token" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Array<Record<string, unknown>> = [];
    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) stdout.push(JSON.parse(line) as Record<string, unknown>);
        index = stdoutBuffer.indexOf("\n");
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const waitForResponses = async (count: number) => {
      const deadline = Date.now() + 10_000;
      while (stdout.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stdout.length).toBeGreaterThanOrEqual(count);
    };

    try {
      // Deliberately pipeline: the notification and requests are written before
      // the initialize response arrives; the bridge must hold them until it
      // has the session id.
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } });
      send({ jsonrpc: "2.0", id: 4, method: "boom/fail", params: {} });
      send({ jsonrpc: "2.0", id: 5, method: "boom/json", params: {} });
      await waitForResponses(5);

      const byId = new Map(
        stdout.filter((message) => "id" in message).map((message) => [message.id, message]),
      );
      expect(byId.get(1)).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
      expect(byId.get(2)).toMatchObject({ result: { tools: [{ name: "link_pull_request" }] } });
      // SSE event payloads are decoded back into plain JSON-RPC messages.
      expect(byId.get(3)).toMatchObject({ result: { ok: true } });
      // A non-JSON error body becomes a JSON-RPC error carrying the request id.
      expect(byId.get(4)).toMatchObject({ error: { code: -32603 } });
      // A JSON error body on a non-2xx is not forwarded as an MCP message; the
      // request id still gets a JSON-RPC error.
      expect(byId.get(5)).toMatchObject({ error: { code: -32603 } });

      const initialize = seen.find((request) => request.method === "initialize");
      expect(initialize?.authorization).toBe("Bearer test-token");

      for (const method of ["notifications/initialized", "tools/list", "tools/call", "boom/fail"]) {
        const request = seen.find((entry) => entry.method === method);
        expect(request?.sessionId).toBe("stub-session-1");
        expect(request?.protocolVersion).toBe("2025-06-18");
        expect(request?.authorization).toBe("Bearer test-token");
      }
      // The notification gets no JSON-RPC response on stdout.
      expect(stdout.every((message) => message.method !== "notifications/initialized")).toBe(true);
    } finally {
      child.kill();
      server.close();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
