import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { toOpenCodeFileParts } from "../provider/opencodeRuntime.ts";
import * as KiloRuntime from "../provider/kilo/KiloRuntime.ts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Only prompt construction is shared. Protocol, credentials and lifetime belong to Kilo. */
export const make = Effect.fn("KiloTextGeneration.make")(function* (attachmentsDir?: string) {
  const runtime = yield* KiloRuntime.KiloRuntime;
  const run: TextGenerationOperations.Runner = (input) =>
    Effect.gen(function* () {
      const separator = input.modelSelection.model.indexOf("/");
      if (separator <= 0)
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kilo models must use provider/model format.",
        });
      if (input.attachments?.length && !attachmentsDir)
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kilo text generation attachments are not configured.",
        });
      const connection = yield* runtime.open(input.cwd);
      const ref = yield* connection.client.create([
        { permission: "*", pattern: "*", action: "deny" },
      ]);
      const agent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
      const response = yield* connection.client.generate(ref, {
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        model: {
          providerID: input.modelSelection.model.slice(0, separator),
          modelID: input.modelSelection.model.slice(separator + 1),
        },
        parts: [
          { type: "text", text: input.prompt },
          ...toOpenCodeFileParts({
            attachments: input.attachments,
            resolveAttachmentPath: (attachment) =>
              attachmentsDir ? resolveAttachmentPath({ attachmentsDir, attachment }) : null,
          }),
        ],
      });
      const text = response.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return yield* TextGenerationOperations.decodeJsonReply(input, "Kilo", text);
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Kilo text generation failed. The request was not retried.",
              cause,
            }),
      ),
    );
  return TextGenerationOperations.fromRunner("KiloTextGeneration", run);
});
