import { Hono } from "hono";
const app = new Hono();
app.get("/", (context) => {
  console.log("alchemy-neon-hono-log-probe");
  return context.text("hono");
});
app.get("/private", (context) =>
  context.req.header("authorization") === "Bearer test-caller"
    ? context.text("authorized")
    : context.text("unauthorized", 401),
);
export default app;
