import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Data from "../../bindings/Data.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return new Response(env.DATA, { headers: { "content-type": "application/octet-stream" } });
  },
};
`;

layer(localRuntimeLayer)("Data binding", (it) => {
  it.effect("exposes the configured byte buffer to the worker", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "data-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [Data.local("DATA", new Uint8Array([1, 2, 3, 4]))],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      const bytes = new Uint8Array(
        yield* Effect.promise(() => res.arrayBuffer()),
      );
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    }),
  );
});
