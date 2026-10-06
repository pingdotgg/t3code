// A real upstream MCP endpoint for verifying credentials sent by Cloudflare.
export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ready");
    }
    const authorization = request.headers.get("authorization");
    const version =
      authorization === "Bearer alchemy-mcp-rotation-v1"
        ? "v1"
        : authorization === "Bearer alchemy-mcp-rotation-v2"
          ? "v2"
          : undefined;
    if (!version) return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    const message = (await request.json()) as {
      id?: number | string;
      method: string;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "alchemy-credential-test", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: `authenticated_${version}`,
                  inputSchema: { type: "object" },
                },
              ],
            }
          : message.method === "prompts/list"
            ? { prompts: [] }
            : {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  },
};
