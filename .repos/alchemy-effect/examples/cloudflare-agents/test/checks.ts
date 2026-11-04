import { expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "agents/client";
import type { Counter, CounterState } from "../src/server.ts";

// The checks shared by the deployed test and the `alchemy dev` test.

// A fresh workers.dev route can refuse the first WebSocket upgrade, which
// the client doesn't retry, so connect again until one is ready.
const connect = async (url: string, name: string) => {
  const { host, protocol } = new URL(url);
  for (let attempt = 1; ; attempt++) {
    const agent = new AgentClient<Counter, CounterState>({
      agent: "counter",
      name,
      host,
      protocol: protocol === "https:" ? "wss" : "ws",
    });
    const ready = await Promise.race([
      agent.ready.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    if (ready) return agent;
    agent.close();
    if (attempt === 8) throw new Error(`agent ${name} never connected`);
  }
};

const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return read();
};

/** The SPA shell from `index.html` and a static asset from `public/`. */
export const checkAssets = async (url: string) => {
  const html = await (await fetch(url)).text();
  expect(html).toContain(`<div id="root"></div>`);
  // Static assets can take a few seconds to propagate after a deploy.
  const asset = await eventually(
    async () => (await fetch(`${url}/agents.txt`)).text(),
    (body) => body.includes("served from public/"),
  );
  expect(asset).toContain("served from public/");
};

/** `@callable()` methods over the agent's WebSocket, with synced state. */
export const checkCallables = async (url: string) => {
  const name = `counter-${crypto.randomUUID()}`;
  const agent = await connect(url, name);
  try {
    expect(await agent.call("increment", [2])).toBe(2);
    expect(await agent.call("increment", [3])).toBe(5);
    await eventually(
      async () => agent.state,
      (state) => state?.count === 5,
    );
    expect(agent.state?.count).toBe(5);
    // The same instance over plain HTTP (`onRequest`).
    const state = (await (await fetch(`${url}/agents/counter/${name}`)).json()) as CounterState;
    expect(state.count).toBe(5);
  } finally {
    agent.close();
  }
};

/** `schedule()` calls the agent back after a delay. */
export const checkSchedule = async (url: string) => {
  const name = `schedule-${crypto.randomUUID()}`;
  const agent = await connect(url, name);
  try {
    await agent.call("remindInOneSecond", []);
  } finally {
    agent.close();
  }
  const state = await eventually(
    async () => (await (await fetch(`${url}/agents/counter/${name}`)).json()) as CounterState,
    (state) => state.reminders === 1,
  );
  expect(state.reminders).toBe(1);
};

/** The `McpAgent` server's tool over MCP's streamable HTTP transport. */
export const checkMcp = async (url: string) => {
  const client = new Client({ name: "alchemy-example-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("add");
    const result = (await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe("5");
  } finally {
    await client.close();
  }
};
