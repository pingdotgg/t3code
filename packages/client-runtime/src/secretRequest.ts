import {
  SecretReference,
  type OrchestrationV2TurnItem,
  type SecretProviderId,
  type SecretRequestAnswerInput,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** A `file` request lets the agent's commands read the value, so its card must not promise more. */
export const secretRequestPrivacyNote = (item: Pick<SecretRequestItem, "delivery" | "fields">) =>
  item.delivery !== "file"
    ? "Stored securely, never shown to the agent"
    : item.fields === undefined
      ? "Kept out of chat, in a private file this agent's commands can read for 24 hours"
      : "Kept out of chat, in private files this agent's commands can read for 24 hours";
const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

export interface SecretRequestInput {
  /** Key in the card's values: the field name, or "" for a request without fields. */
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  /** Masked, with a toggle to show it. */
  readonly secret: boolean;
}

export function secretRequestInputs(
  item: Pick<SecretRequestItem, "label" | "placeholder" | "fields">,
): ReadonlyArray<SecretRequestInput> {
  if (item.fields === undefined) {
    return [
      {
        key: "",
        label: item.label,
        placeholder: item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER,
        secret: true,
      },
    ];
  }
  return item.fields.map((field) => ({
    key: field.name,
    label: field.label,
    placeholder: field.placeholder ?? "",
    secret: field.secret !== false,
  }));
}

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

/** A configured secret provider a pending card can read its answer from. */
export interface SecretRequestSource {
  readonly id: SecretProviderId;
  readonly label: string;
  readonly isReference: (reference: string) => boolean;
  readonly referencePlaceholder: string;
  readonly invalidReferenceMessage: string;
}

const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];
const decodeConfigByKind = new Map(
  builtInSecretProviderDefinitions.definitions.map((definition) => [
    definition.kind,
    Schema.decodeUnknownOption(definition.configSchema),
  ]),
);

/** Empty unless the server accepts reference answers; providers this build cannot read are left out. */
export function secretRequestSources(
  config: Pick<ServerConfig, "secretRequestReferences"> | null | undefined,
  providers: ServerSettings["secretProviders"],
): ReadonlyArray<SecretRequestSource> {
  if (config?.secretRequestReferences !== true) return NO_SOURCES;
  return configuredSecretSources(providers);
}

export function configuredSecretSources(
  providers: ServerSettings["secretProviders"],
): ReadonlyArray<SecretRequestSource> {
  return (Object.keys(providers) as Array<SecretProviderId>).flatMap((id) => {
    const provider = providers[id];
    const definition =
      provider === undefined ? undefined : builtInSecretProviderDefinitions.find(provider.kind);
    if (
      provider === undefined ||
      definition === undefined ||
      decodeConfigByKind.get(definition.kind)?.(provider.config)._tag !== "Some"
    ) {
      return [];
    }
    return [
      {
        id,
        label: provider.label,
        isReference: definition.isReference,
        referencePlaceholder: definition.referencePlaceholder,
        invalidReferenceMessage: definition.invalidReferenceMessage,
      },
    ];
  });
}

const decodeSecretReference = Schema.decodeUnknownOption(SecretReference);

/** The reference `text` names, or undefined when it is not `source`'s syntax. */
export function secretRequestReference(
  source: SecretRequestSource,
  text: string,
): SecretReference | undefined {
  const decoded = decodeSecretReference({ provider: source.id, reference: text.trim() });
  return Option.isSome(decoded) && source.isReference(decoded.value.reference)
    ? decoded.value
    : undefined;
}

/** A card value by input key. Own keys only: a field may be named `constructor`. */
export const secretRequestValue = (values: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(values, key) ? (values[key] ?? "") : "";

export type SecretRequestReply =
  /** Keyed by `SecretRequestInput.key`. */
  | { readonly type: "save"; readonly values: Readonly<Record<string, string>> }
  /** Single-value cards only: the server reads it through `source`. */
  | { readonly type: "reference"; readonly source: SecretRequestSource; readonly reference: string }
  | { readonly type: "decline" };

/** Null until every input has a value, or while a reference is not `source`'s syntax. */
export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId" | "label" | "placeholder" | "fields">,
  answer: SecretRequestReply,
): SecretRequestAnswerInput | null {
  const base = { threadId: item.threadId, turnItemId: item.id };
  if (answer.type === "decline") return { ...base, answer: { type: "decline" } };
  if (answer.type === "reference") {
    const reference =
      item.fields === undefined
        ? secretRequestReference(answer.source, answer.reference)
        : undefined;
    return reference === undefined ? null : { ...base, answer: { type: "reference", reference } };
  }
  const entries = secretRequestInputs(item).map(
    (input) => [input.key, secretRequestValue(answer.values, input.key).trim()] as const,
  );
  if (entries.some(([, value]) => value.length === 0)) return null;
  if (item.fields === undefined) {
    return { ...base, answer: { type: "save", secret: entries[0]?.[1] ?? "" } };
  }

  return { ...base, answer: { type: "save", values: Object.fromEntries(entries) } };
}

const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Only known server errors pass their message through: anything else (transport or encoding
 * failures) gets the generic copy, so the typed value can never surface in the UI.
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
