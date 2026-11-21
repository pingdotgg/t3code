import { msg } from "gt-i18n";
import { errorMessage } from "./errorMessage.ts";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

/** The http(s) page a secret card may open, or null for anything else. */
export function secretRequestPageUrl(value: string): URL | null {
  // React Native's URL has no `canParse`.
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch {
    return null;
  }
}

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("decline") }),
    /** Read once through a configured secret provider; only servers advertising `secretRequestReferences` accept it. */
    Schema.Struct({ type: Schema.Literal("reference"), reference: SecretReference }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

/** What the agent reads when its card ends without a secret. */
export const SECRET_REQUEST_UNSAVED_NOTE = {
  declined:
    "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.",
  cancelled:
    "The card closed with the run. Ask again with a new clientRequestId only if the secret is still needed.",
  timed_out:
    "No answer in time. Don't ask in chat; ask again with a new clientRequestId only if it is still needed.",
} as const;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: msg("Could not load the secret request."),
  not_found: msg("This secret request no longer exists."),
  already_answered: msg("This secret request was already answered."),
  agent_stopped: msg("The agent that asked has stopped, so this secret can't be used."),
  store_failed: msg("Could not store the secret."),
  reference_unreadable: msg("Could not read the secret from the secret provider."),
  record_failed: msg("Saved the secret, but could not update the request."),
  invalid_ref: msg("That {referenceField} is not valid.", { referenceField: "secretRef" }),
  read_failed: msg("Could not read the secret."),
  ref_unavailable: msg(
    "That {referenceField} was already used or does not exist. Ask the user again with {command}.",
    { referenceField: "secretRef", command: "request_secret" },
  ),
  ref_expired: msg("That {referenceField} expired. Ask the user again with {command}.", {
    referenceField: "secretRef",
    command: "request_secret",
  }),
  consume_failed: msg("Could not use that {referenceField}. Try again.", {
    referenceField: "secretRef",
  }),
  not_a_file_request: msg(
    "The user did not save this secret for shell use. Ask again with {command} and {deliveryOption}.",
    { command: "request_secret", deliveryOption: 'delivery: "file"' },
  ),
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    /** The secret provider a `reference_unreadable` answer named. */
    provider: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "reference_unreadable" && this.provider !== undefined) {
      return errorMessage(
        msg(
          'Could not read the secret from the secret provider "{provider}". Unlock it and try again, or enter the value.',
          { provider: this.provider },
        ),
      );
    }
    return errorMessage(SECRET_REQUEST_FAILURE_MESSAGES[this.reason]);
  }
}
