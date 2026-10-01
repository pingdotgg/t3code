import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { browserLocalServersApi, GENERIC_API_CATALOGUE } from "../dist/catalogue.js";
import { bindStreamApi } from "../dist/capabilities.js";

NodeTest.test(
  "independent SDK consumer receives a replacement snapshot through the typed public facade",
  async () => {
    const context = {
      client: "web",
      resource: {
        namespace: "example.browser-local-servers",
        id: "view",
        environmentId: "env",
        projectId: "project",
      },
    };
    const value = {
      kind: "snapshot",
      scope: "environment",
      servers: [{ url: "http://localhost:5173/", port: 5173 }],
      truncated: false,
    };
    const controller = new AbortController();
    const client = bindStreamApi(
      browserLocalServersApi,
      {
        async *subscribeApi(request, signal) {
          NodeAssert.equal(request.id, "t3.browser/local-servers");
          NodeAssert.equal(request.name, "subscribe");
          NodeAssert.deepEqual(request.input, {});
          NodeAssert.deepEqual(request.context, context);
          NodeAssert.equal(signal, controller.signal);
          yield { type: "snapshot", value };
        },
      },
      context,
    );
    const result = await Array.fromAsync(client.subscribe("subscribe", {}, controller.signal));
    NodeAssert.deepEqual(
      result.map((frame) => frame.value),
      [value],
    );
    NodeAssert.ok(GENERIC_API_CATALOGUE.includes(browserLocalServersApi.definition));
  },
);
