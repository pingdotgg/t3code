/**
 * Tests for the `request.cf` object exposed to user workers, mirroring
 * Miniflare's behaviour (`workers-sdk/packages/miniflare/src/cf.ts` and
 * `workers/core/entry.worker.ts`): a static fallback blob by default, a
 * layer-provided override via the `Cf` reference, and a per-request override
 * via the `MF-CF-Blob` header.
 */
import { expect, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cf from "../../globals/Cf.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const TEST_SCRIPT = `
export default {
  async fetch(request) {
    return Response.json(request.cf ?? null);
  },
};
`;

class CfTestWorker extends Context.Service<CfTestWorker, TestWorker>()(
  "test/CfTestWorker",
) {}

const CfTestWorkerLive = Layer.effect(
  CfTestWorker,
  startTestWorker({
    name: "cf-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [],
  }),
);

layer(CfTestWorkerLive.pipe(Layer.provideMerge(localRuntimeLayer)))(
  "request.cf",
  (it) => {
    it.effect("defaults to the fallback blob", () =>
      Effect.gen(function* () {
        const worker = yield* CfTestWorker;
        const cf = yield* worker.fetchJson<Record<string, unknown>>("/", {
          headers: { "Accept-Encoding": "gzip" },
        });
        // Fallback fields (Miniflare's static placeholder blob)
        expect(cf.country).toBe("US");
        expect(cf.colo).toBe("DFW");
        expect(cf.city).toBe("Austin");
        expect(cf.asn).toBe(395747);
        expect(cf.tlsVersion).toBe("TLSv1.3");
        // The client's `Accept-Encoding` is preserved on `clientAcceptEncoding`
        // (workerd rewrites the user request's `Accept-Encoding`)
        expect(cf.clientAcceptEncoding).toBe("gzip");
      }),
    );

    it.effect("uses the MF-CF-Blob header verbatim when present", () =>
      Effect.gen(function* () {
        const worker = yield* CfTestWorker;
        const cf = yield* worker.fetchJson<Record<string, unknown>>("/", {
          headers: {
            [Cf.HEADER_CF_BLOB]: JSON.stringify({ country: "GB", colo: "LHR" }),
          },
        });
        expect(cf).toEqual({ country: "GB", colo: "LHR" });
      }),
    );
  },
);

layer(
  CfTestWorkerLive.pipe(
    Layer.provideMerge(localRuntimeLayer),
    Layer.provide(
      Layer.succeed(Cf.Cf, { ...Cf.fallbackCf, country: "AU", colo: "SYD" }),
    ),
  ),
)("request.cf with Cf layer override", (it) => {
  it.effect("uses the overridden blob", () =>
    Effect.gen(function* () {
      const worker = yield* CfTestWorker;
      const cf = yield* worker.fetchJson<Record<string, unknown>>("/");
      expect(cf.country).toBe("AU");
      expect(cf.colo).toBe("SYD");
      // Untouched fallback fields are preserved
      expect(cf.city).toBe("Austin");
    }),
  );
});
