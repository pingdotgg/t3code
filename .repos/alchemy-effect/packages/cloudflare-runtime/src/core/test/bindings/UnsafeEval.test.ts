import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as UnsafeEval from "../../bindings/UnsafeEval.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return new Response(String(env.EVAL.eval("1 + 2")));
  },
};
`;

layer(localRuntimeLayer)("UnsafeEval binding", (it) => {
  it.effect("evaluates expressions inside the worker", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "unsafe-eval-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [UnsafeEval.local("EVAL")],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      expect(yield* Effect.promise(() => res.text())).toBe("3");
    }),
  );
});
