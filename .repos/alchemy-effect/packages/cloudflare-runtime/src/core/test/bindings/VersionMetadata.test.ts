import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as VersionMetadata from "../../bindings/VersionMetadata.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(_request, env) {
    return Response.json({
      hasId: typeof env.META.id === "string" && env.META.id.length > 0,
      tag: env.META.tag,
      timestamp: env.META.timestamp,
    });
  },
};
`;

layer(localRuntimeLayer)("VersionMetadata binding", (it) => {
  it.effect("exposes a stub version metadata object to the worker", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "version-metadata-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [VersionMetadata.local("META")],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
      });

      const res = yield* fetch("/");
      expect(yield* Effect.promise(() => res.json())).toEqual({
        hasId: true,
        tag: "",
        timestamp: "0",
      });
    }),
  );
});
