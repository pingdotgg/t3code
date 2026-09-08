import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Text from "../../bindings/Text.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return new Response(env.TEXT);
  },
};
`;

layer(localRuntimeLayer)("Text binding", (it) => {
  it.effect("exposes the configured text value to the worker", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "text-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [Text.local("TEXT", "hello-text")],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      expect(yield* Effect.promise(() => res.text())).toBe("hello-text");
    }),
  );
});
