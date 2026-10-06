import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KiloRuntime from "../provider/kilo/KiloRuntime.ts";
import * as KiloTextGeneration from "./KiloTextGeneration.ts";

it.effect("keeps runtime diagnostics in the cause of a bounded text-generation error", () =>
  Effect.gen(function* () {
    const cause = new KiloRuntime.KiloRuntimeError({
      operation: "open",
      detail: "Private runtime diagnostic",
    });
    const textGeneration = yield* KiloTextGeneration.make().pipe(
      Effect.provideService(KiloRuntime.KiloRuntime, {
        open: () => Effect.fail(cause),
      }),
    );
    const error = yield* textGeneration
      .generateThreadTitle({
        cwd: "/workspace/project",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kilo"),
          model: "provider/model",
        },
        message: "Name this thread",
      })
      .pipe(Effect.flip);

    assert.equal(error.operation, "generateThreadTitle");
    assert.equal(error.detail, "Kilo text generation failed. The request was not retried.");
    assert.strictEqual(error.cause, cause);
  }),
);
