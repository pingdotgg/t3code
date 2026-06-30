import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ProviderResponsePort,
  type ProviderResponsePortShape,
} from "../Services/ProviderResponsePort.ts";

const toResponseError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "provider response failed", cause });

export const ProviderResponsePortLive = Layer.effect(
  ProviderResponsePort,
  Effect.gen(function* () {
    const provider = yield* ProviderService;

    const respond: ProviderResponsePortShape["respond"] = (input) => {
      if (input.responseKind === "request") {
        return provider
          .respondToRequest({
            threadId: input.threadId,
            requestId: input.requestId,
            decision: input.approved ? "accept" : "decline",
          })
          .pipe(Effect.mapError(toResponseError));
      }

      if (
        input.text !== undefined &&
        (input.questionId === undefined || input.questionId.trim().length === 0)
      ) {
        return Effect.fail(
          new WorkflowEventStoreError({
            message: "provider user-input text response requires a question id",
          }),
        );
      }

      return provider
        .respondToUserInput({
          threadId: input.threadId,
          requestId: input.requestId,
          answers:
            input.questionId === undefined || input.text === undefined
              ? {}
              : { [input.questionId]: input.text },
        })
        .pipe(Effect.mapError(toResponseError));
    };

    return { respond } satisfies ProviderResponsePortShape;
  }),
);
