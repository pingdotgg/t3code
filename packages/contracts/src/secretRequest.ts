import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";
import {
  GMAIL_MAX_MESSAGES,
  GmailMessageSummary,
  LocalVaultName,
  LocalVaultField,
  VaultPin,
  VaultServiceItem,
  VAULT_SERVICE_MAX_ITEMS,
} from "./localVault.ts";

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

export const isRetiredVaultOperation = (id: string | undefined): boolean =>
  id?.startsWith("turn-item:vault-access:") === true;

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    /** A request with `fields`: one value per field name. */
    Schema.Struct({
      type: Schema.Literal("save"),
      values: Schema.Record(Schema.String, TrimmedNonEmptyString),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
    Schema.Struct({
      type: Schema.Literal("vault"),
      name: LocalVaultName,
      fields: Schema.Record(Schema.String, LocalVaultField),
      pin: Schema.optionalKey(VaultPin),
      discloseToCommands: Schema.optionalKey(Schema.Boolean),
    }),
    // A separate discriminator makes older servers reject private display rather than share mail.
    Schema.Struct({
      type: Schema.Literal("vault_gmail_display"),
      name: LocalVaultName,
      account: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
      pin: VaultPin,
    }),
    Schema.Struct({
      type: Schema.Literal("vault_service_display"),
      name: LocalVaultName,
      account: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
      pin: VaultPin,
    }),
    /** Read once through a configured secret provider; only servers advertising `secretRequestReferences` accept it. */
    Schema.Struct({
      type: Schema.Literal("reference"),
      reference: SecretReference,
      pin: Schema.optionalKey(VaultPin),
      discloseToCommands: Schema.optionalKey(Schema.Boolean),
    }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

export const SecretRequestAnswerResult = Schema.UndefinedOr(
  Schema.Union([
    Schema.Struct({
      messages: Schema.Array(GmailMessageSummary).check(Schema.isMaxLength(GMAIL_MAX_MESSAGES)),
    }),
    Schema.Struct({
      items: Schema.Array(VaultServiceItem).check(Schema.isMaxLength(VAULT_SERVICE_MAX_ITEMS)),
    }),
  ]),
);
export type SecretRequestAnswerResult = typeof SecretRequestAnswerResult.Type;

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
  load_failed: "Could not load the secret request.",
  vault_pin_required: "Enter your vault PIN to approve this request.",
  vault_pin_invalid: "Incorrect vault PIN. Try again.",
  vault_pin_locked: "Too many PIN attempts. Wait for the cooldown shown in Settings → Secrets.",
  vault_pin_not_set: "Set a vault PIN in Settings → Secrets before using saved credentials.",
  vault_tag_unavailable:
    "The tagged entry is unavailable or its name is not unique. Check Settings → Secrets.",
  vault_tag_login:
    "No Hyakki tool supports protected use of this website login. Do not request its password.",
  vault_gmail_not_connected:
    "Gmail is not connected to the tagged entry. Connect it in Settings → Secrets.",
  vault_gmail_approval:
    "This approval cannot be used for that Gmail read. No email details were shared.",
  vault_service_not_connected:
    "This credential is not connected to the requested service. Check Settings → Secrets.",
  vault_service_approval:
    "This approval does not match the requested service read. No private items were shared.",
  vault_access_denied:
    "Vault approval was refused. Check the PIN and access rules in Settings → Secrets.",
  vault_use_picker:
    "Use the saved-entry picker and confirm vault access instead of a raw vault reference.",
  vault_disclosure_required:
    "Explicitly allow command access before sharing real saved fields with an agent.",
  vault_origin_mismatch:
    "This login is saved for a different website. Ask the agent to include the exact saved HTTPS website in its credential request.",
  operation_request: "This old mailbox request is no longer active.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  fields_mismatch: "This request asks for different values. Update the app and try again.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  reference_unreadable: "Could not read the secret from the secret provider.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
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
      return `Could not read the secret from the secret provider "${this.provider}". Unlock it and try again, or enter the value.`;
    }
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
