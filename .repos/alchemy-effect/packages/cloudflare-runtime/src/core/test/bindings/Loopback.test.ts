import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Loopback from "../../bindings/Loopback.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return await env.LOOPBACK.fetch("https://loopback.invalid/echo");
  },
};
`;

layer(localRuntimeLayer)("Loopback binding", (it) => {
  it.effect("routes worker fetches back to the host handler", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "loopback-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [
          Loopback.local({
            binding: "LOOPBACK",
            name: "test-route",
            handler: (_req, res) => {
              res.writeHead(200, { "content-type": "text/plain" });
              res.end("loopback-ok");
            },
          }),
        ],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      expect(res.status).toBe(200);
      expect(yield* Effect.promise(() => res.text())).toBe("loopback-ok");
    }),
  );
});
