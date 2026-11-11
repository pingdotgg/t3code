import { Hono } from "hono";

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true }));
export default app;
