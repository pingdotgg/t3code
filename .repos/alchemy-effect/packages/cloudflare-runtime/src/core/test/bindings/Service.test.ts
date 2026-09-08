import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Assets from "../../bindings/assets/Assets.ts";
import * as Service from "../../bindings/Service.ts";
import { getFixture } from "../helpers/fixture.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SELF_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/self-ping") {
      const res = await env.SELF.fetch(new URL("/ping", url));
      return new Response("self:" + (await res.text()));
    }
    if (url.pathname === "/self-root") {
      const res = await env.SELF.fetch(new URL("/", url));
      return new Response("self:" + (await res.text()));
    }
    return new Response("worker-fallthrough");
  },
};
`;

layer(localRuntimeLayer)("Service.self binding", (it) => {
  it.effect("binds the worker to itself", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "service-self",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [Service.self("SELF")],
        modules: [{ name: "main.js", type: "ESModule", content: SELF_SCRIPT }],
      });
      expect(yield* worker.fetchText("/self-ping")).toBe("self:pong");
    }),
  );

  it.effect("bypasses the assets middleware chain", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "service-self-assets",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [Service.self("SELF"), Assets.local("ASSETS")],
        modules: [{ name: "main.js", type: "ESModule", content: SELF_SCRIPT }],
        assets: { directory: getFixture("assets"), runWorkerFirst: false },
      });
      // From the outside, "/" is served by the assets middleware.
      expect(yield* worker.fetchText("/")).toBe("<h1>home</h1>\n");
      // Through the self binding, the same path reaches the worker's own
      // fetch handler directly, bypassing the assets middleware.
      expect(yield* worker.fetchText("/self-root")).toBe(
        "self:worker-fallthrough",
      );
    }),
  );
});
