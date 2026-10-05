import type { OrchestrationV2TurnItem, SecretRequestAnswerInput } from "@t3tools/contracts";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** Shown under the field: the one promise the card makes about the value. */
export const SECRET_REQUEST_PRIVACY_NOTE = "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

/** What a secret request card shows: the form while pending, otherwise a one-line outcome. */
export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const SAVED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Saved securely and kept private",
};
const DECLINED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Declined",
};
const ENDED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "ended",
  label: "Request ended",
};
const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };
const PENDING_ELSEWHERE_DISPLAY: SecretRequestDisplay = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
};

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved":
      return SAVED_DISPLAY;
    case "declined":
      return DECLINED_DISPLAY;
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

/**
 * Builds the RPC payload for an answer. A save with a blank value returns null,
 * since the server rejects it; callers keep Save disabled instead.
 */
export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId">,
  answer: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } };
  }
  const secret = answer.secret.trim();
  if (secret.length === 0) return null;
  return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save", secret } };
}

/** Failures whose message is written for the user and never echoes the request payload. */
const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Inline error copy for a failed answer. Only known server errors pass their
 * message through: anything else (transport or encoding failures) gets the
 * generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
