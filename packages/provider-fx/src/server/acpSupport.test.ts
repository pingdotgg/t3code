import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { applyFxModelSelection, fxPermissionDisposition } from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });
});

describe("fx model selection", () => {
  it.effect.each(["unavailable", "rejected"] as const)(
    "restores the original backend and model when Default is %s",
    (failure) =>
      Effect.gen(function* () {
        let backend = "codex";
        let model = "codex-custom";
        const configOptions = (): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
          {
            id: "provider",
            name: "provider",
            type: "select",
            currentValue: backend,
            options: ["codex", "gateway"].map((value) => ({ value, name: value })),
          },
          {
            id: "model",
            name: "model",
            type: "select",
            currentValue: model,
            options: (backend === "codex"
              ? ["codex-default", "codex-custom"]
              : ["gateway-fallback", ...(failure === "rejected" ? ["gateway-default"] : [])]
            ).map((value) => ({ value, name: value })),
          },
        ];
        const runtime = {
          getConfigOptions: Effect.sync(configOptions),
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.gen(function* () {
              if (id === "provider") {
                backend = String(value);
                model = backend === "codex" ? "codex-default" : "gateway-fallback";
              } else if (id === "model") {
                if (value === "gateway-default") {
                  return yield* new EffectAcpErrors.AcpRequestError({
                    code: -32602,
                    errorMessage: "Model rejected",
                  });
                }
                model = String(value);
              }
              return { configOptions: configOptions() };
            }),
        };
        const result = yield* applyFxModelSelection(
          runtime,
          { instanceId: ProviderInstanceId.make("fx"), model: "default" },
          Effect.succeed({ backend: "gateway", model: "gateway-default" }),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          assert.include(
            Cause.pretty(result.cause),
            failure === "unavailable"
              ? "The default fx model is unavailable on its configured backend."
              : "Model rejected",
          );
        }
        assert.equal(backend, "codex");
        assert.equal(model, "codex-custom");
      }),
  );
});
