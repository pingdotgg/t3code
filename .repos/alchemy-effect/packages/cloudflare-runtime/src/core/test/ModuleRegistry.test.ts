import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as D1 from "../bindings/d1/index.ts";
import { localRuntimeLayer, startTestWorker } from "./helpers/runtime.ts";

layer(localRuntimeLayer)("Module registry defaults", (it) => {
  for (const legacy of [false, true]) {
    it.effect(
      `queries D1 with the ${legacy ? "legacy" : "default"} registry`,
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: `module-registry-d1-${legacy ? "legacy" : "default"}`,
            compatibilityDate: "2026-08-31",
            compatibilityFlags: legacy ? ["legacy_module_registry"] : [],
            bindings: [
              D1.local({ binding: "DB", id: `module-registry-${legacy}` }),
            ],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: `export default {
                async fetch(request, env) {
                  const row = await env.DB.prepare('SELECT 42 AS value').first();
                  return Response.json({ value: row.value, resolve: typeof import.meta.resolve });
                },
              };`,
              },
            ],
          });
          expect(yield* worker.fetchJson("/")).toEqual({
            value: 42,
            resolve: legacy ? "undefined" : "function",
          });
        }),
    );
  }

  it.effect("exposes native import.meta without an explicit flag", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "module-registry-default",
        compatibilityDate: "2026-08-31",
        compatibilityFlags: [],
        bindings: [],
        modules: [
          {
            name: "main.js",
            type: "ESModule",
            content: `export default {
              fetch() {
                return Response.json({
                  main: import.meta.main,
                  url: import.meta.url,
                  resolved: import.meta.resolve('./helper.js'),
                });
              },
            };`,
          },
        ],
      });
      expect(yield* worker.fetchJson("/")).toEqual({
        main: true,
        url: "file:///bundle/main.js",
        resolved: "file:///bundle/helper.js",
      });
    }),
  );
});
