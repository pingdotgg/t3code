import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { Assistant } from "./agents/assistant.ts";

const app = new Hono();

// Runs in the Worker isolate, outside any agent's Durable Object.
app.get("/api/ping", (c) => c.json({ pong: true }));

// The agent's conversations: `POST /agents/assistant/:id` prompts it,
// `GET /agents/assistant/:id` streams the conversation.
app.route("/agents/assistant", createAgentRouter(Assistant));

export default app;
