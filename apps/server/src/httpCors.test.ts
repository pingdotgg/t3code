import { expect, test } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import { layerBrowserApiCors } from "./http.ts";

test("browser API CORS accepts authenticated MCP session headers", async () => {
  const layerRoute = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add("POST", "/mcp", HttpServerResponse.empty());
    }),
  );
  const layerApp = Layer.merge(layerRoute, layerBrowserApiCors).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

  try {
    const response = await handler(
      new Request("https://backend.example/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "POST",
          "access-control-request-headers": [
            ORCHESTRATION_PROTOCOL_HEADER,
            "authorization",
            "mcp-session-id",
            "mcp-protocol-version",
          ].join(", "),
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const allowedHeaders = new Set(
      (response.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase()),
    );
    expect(allowedHeaders.has("mcp-session-id")).toBe(true);
    expect(allowedHeaders.has("mcp-protocol-version")).toBe(true);
  } finally {
    await dispose();
  }
});
