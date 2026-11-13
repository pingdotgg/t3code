import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Agent, callable, routeAgentRequest } from "agents";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  Counter: DurableObjectNamespace<Counter>;
  MCP_OBJECT: DurableObjectNamespace<Calculator>;
}

export interface CounterState {
  count: number;
  reminders: number;
}

/**
 * A stateful agent: its state syncs to every connected client, `@callable()`
 * methods run over the agent's WebSocket, and `schedule()` calls back later.
 */
export class Counter extends Agent<Env, CounterState> {
  initialState: CounterState = { count: 0, reminders: 0 };

  @callable()
  increment(by: number) {
    this.setState({ ...this.state, count: this.state.count + by });
    return this.state.count;
  }

  @callable()
  async remindInOneSecond() {
    await this.schedule(1, "remind");
  }

  remind() {
    this.setState({ ...this.state, reminders: this.state.reminders + 1 });
  }

  // `GET /agents/counter/:name` outside a WebSocket.
  onRequest() {
    return Response.json(this.state);
  }
}

/** An MCP server agent with one tool, served at `/mcp`. */
export class Calculator extends McpAgent<Env> {
  server = new McpServer({ name: "calculator", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "add",
      { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
    );
  }
}

const mcp = Calculator.serve("/mcp");

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/mcp")) {
      return mcp.fetch(request, env, ctx);
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
