import type { ProviderUserInputAnswers, UserInputAttachments } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ProviderValidationError } from "./Errors.ts";

const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const UserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isUserInputAnswerObject = Schema.is(UserInputAnswerObject);
const isStringArray = Schema.is(Schema.Array(Schema.String));

/**
 * Normalize the wire answer shapes to what every provider adapter reads:
 * strings stay strings, string arrays stay arrays, and the Codex-style
 * `{ answers: string[] }` object unwraps to its entries. Anything else fails
 * before the pending request is consumed so the client can retry.
 */
export const normalizeUserInputAnswers = Effect.fn("normalizeUserInputAnswers")(function* (
  answers: ProviderUserInputAnswers,
): Effect.fn.Return<Record<string, string | string[]>, ProviderValidationError> {
  const normalized = new Map<string, string | string[]>();
  for (const [index, [questionId, value]] of Object.entries(answers).entries()) {
    if (typeof value === "string") {
      normalized.set(questionId, value);
    } else if (isStringArray(value)) {
      normalized.set(questionId, [...value]);
    } else if (isUserInputAnswerObject(value)) {
      const [only] = value.answers;
      normalized.set(
        questionId,
        value.answers.length === 1 && only !== undefined ? only : [...value.answers],
      );
    } else {
      // Report the position, not the client-controlled key: error attributes
      // stay safe and bounded.
      return yield* new ProviderValidationError({
        operation: "respondToUserInput",
        issue: `Answer at index ${index} must be a string, a string array, or { answers: string[] }.`,
      });
    }
  }
  return Object.fromEntries(normalized);
});

/** Keep provider answer protocols unchanged; paths refer to files on the provider's server. */
export const appendUserInputAttachmentPaths = Effect.fn("appendUserInputAttachmentPaths")(
  function* (input: {
    answers: ProviderUserInputAnswers;
    attachmentsByQuestionId?: UserInputAttachments | undefined;
    attachmentsDir: string;
  }) {
    const answers = new Map(Object.entries(input.answers));
    const fs = yield* FileSystem.FileSystem;
    for (const [questionId, attachments] of Object.entries(input.attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const references: string[] = [];
      for (const attachment of attachments) {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        if (
          !path ||
          !(yield* fs.exists(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderValidationError({
                  operation: "respondToUserInput",
                  issue: `Could not access attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          ))
        ) {
          return yield* new ProviderValidationError({
            operation: "respondToUserInput",
            issue: `Attachment '${attachment.name}' is no longer available. Attach it again.`,
          });
        }
        references.push(
          `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(path)}`,
        );
      }
      const answer = answers.get(questionId);
      const text = references.join("\n");
      answers.set(
        questionId,
        Array.isArray(answer)
          ? [...answer, text]
          : typeof answer === "string" && answer.length > 0
            ? `${answer}\n\n${text}`
            : text,
      );
    }
    return Object.fromEntries(answers);
  },
);
