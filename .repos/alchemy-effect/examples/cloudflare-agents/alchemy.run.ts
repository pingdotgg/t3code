import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareAgentsExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Vite("Website", {
      main: "./src/server.ts",
      compatibility: {
        date: "2026-06-11",
        flags: ["nodejs_compat"],
      },
      memo: {
        include: ["src/**", "public/**", "index.html", "package.json", "vite.config.ts"],
      },
      assets: {
        notFoundHandling: "single-page-application",
        // Agent and MCP requests reach the Worker even when they accept HTML.
        runWorkerFirst: ["/agents/*", "/mcp", "/mcp/*"],
      },
      env: {
        // `routeAgentRequest` maps `/agents/counter/:name` to the binding
        // named after the class.
        Counter: Cloudflare.DurableObject("Counter", { className: "Counter" }),
        // `McpAgent.serve()` binds its Durable Object as `MCP_OBJECT`.
        MCP_OBJECT: Cloudflare.DurableObject("Calculator", { className: "Calculator" }),
      },
    });

    return {
      url: site.url,
    };
  }),
);
