import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeKiroAcpAdapterFlavor } from "./KiroAdapterV2.ts";

const flavor = makeKiroAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("kiro-test"),
  settings: { enabled: true, binaryPath: "kiro-cli", customModels: [] },
  environment: {},
  childProcessSpawner: undefined as never,
  crypto: undefined as never,
  selfInvocation: undefined as never,
  fileSystem: undefined as never,
  idAllocator: undefined as never,
  serverConfig: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
});

describe("KiroAdapterV2 flavor", () => {
  it.effect("selects models through session/set_model on the v1 session state", () =>
    Effect.gen(function* () {
      const modelIds: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            modelIds.push(modelId);
            return {};
          }),
      };
      const startResult = {
        sessionId: "session-1",
        initializeResult: { protocolVersion: 1 },
        sessionSetupResult: {
          sessionId: "session-1",
          models: { currentModelId: "auto", availableModels: [] },
        },
        modelConfigId: undefined,
      };
      const applied = yield* flavor.applyModelSelection!({
        runtime: runtime as never,
        startResult,
        modelSelection: { instanceId: ProviderInstanceId.make("kiro-test"), model: "glm-5" },
      });
      assert.equal(applied, "glm-5");
      assert.deepEqual(modelIds, ["glm-5"]);
      // The default keeps whatever the session already runs.
      const kept = yield* flavor.applyModelSelection!({
        runtime: runtime as never,
        startResult,
        modelSelection: { instanceId: ProviderInstanceId.make("kiro-test"), model: "" },
      });
      assert.equal(kept, "auto");
      assert.deepEqual(modelIds, ["glm-5"]);
    }),
  );

  it("explains a logged-out CLI when the process exits before the session starts", () => {
    assert.include(
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpProcessExitedError({ code: 1, stderr: "error: Not logged in" }),
      ).message ?? "",
      "kiro-cli login",
    );
  });
});
