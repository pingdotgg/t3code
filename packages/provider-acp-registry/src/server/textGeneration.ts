import { TextGenerationError } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  makeAcpRegistryManagementRuntime,
  type AcpRegistryConfigurationProbeInput,
} from "./probe.ts";

const TIMEOUT = "3 minutes";
const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Runs each request in a hidden ACP session that is deleted afterwards. Given the thread's
 * session and a negotiated `session/fork`, it forks that session so the agent reuses its context.
 */
export const makeAcpRegistryTextGeneration = (
  input: Omit<AcpRegistryConfigurationProbeInput, "cwd">,
  services: {
    readonly catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"];
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly random: SecureRandom.SecureRandom["Service"];
  },
): ProviderTextGeneration => {
  const run: TextGenerationOperations.Runner = Effect.fn("AcpRegistryTextGeneration.run")(
    function* (request) {
      const runtime = yield* makeAcpRegistryManagementRuntime({ ...input, cwd: request.cwd });
      const output = yield* Ref.make("");
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const chunk = update.content.text;
        return Ref.update(output, (text) => text + chunk);
      });
      // A hidden session must never act on the checkout.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" } } as const),
      );
      // Never delete the source: only the sessions opened here.
      const forget = (sessionId: string) =>
        Effect.addFinalizer(() => runtime.deleteSession(sessionId).pipe(Effect.ignore));
      const started = yield* runtime.start();
      yield* forget(started.sessionId);
      if (
        request.sourceSessionId !== undefined &&
        started.initializeResult.agentCapabilities?.sessionCapabilities?.fork != null
      ) {
        yield* forget((yield* runtime.forkSession(request.sourceSessionId)).sessionId);
      }
      const model = request.modelSelection.model;
      const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
      if (model.length > 0 && model !== "default" && modelOption?.currentValue !== model) {
        yield* (
          modelOption === undefined
            ? runtime.setSessionModel(model)
            : runtime.setConfigOption(modelOption.id, model, { allowUnlistedValue: true })
        ).pipe(Effect.ignore);
      }
      yield* runtime.prompt({ prompt: [{ type: "text", text: request.prompt }] });
      const text = (yield* Ref.get(output)).trim();
      if (text.length === 0) {
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: "The ACP agent returned no text.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "ACP agent", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: "The ACP agent did not answer in time.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: `ACP request failed: ${cause.message}`,
                cause,
              }),
        ),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, services.catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
        Effect.provideService(SecureRandom.SecureRandom, services.random),
      ),
  );
  return TextGenerationOperations.fromRunner(
    "AcpRegistryTextGeneration",
    TextGenerationOperations.withoutInvestigation("ACP Registry", run),
  );
};
