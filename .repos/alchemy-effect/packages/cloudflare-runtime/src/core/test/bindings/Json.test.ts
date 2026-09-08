import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Json from "../../bindings/Json.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return Response.json(env.JSON);
  },
};
`;

layer(localRuntimeLayer)("Json binding", (it) => {
  it.effect("exposes the configured json value to the worker", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "json-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [Json.local("JSON", { a: 1, b: ["c", "d"] })],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      expect(yield* Effect.promise(() => res.json())).toEqual({
        a: 1,
        b: ["c", "d"],
      });
    }),
  );
});
