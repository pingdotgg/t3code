import { errorDisplayMessage } from "./errors/translatable.ts";
import {
  SecretReference,
  isRetiredVaultOperation,
  secretRequestPageUrl,
  type OrchestrationV2TurnItem,
  type SecretProviderId,
  type SecretRequestAnswerInput,
  type ServerConfig,
  type VaultServiceRead,
  type ServerSettings,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** Describe the fixed operation, not an agent-provided reason or URL. */
export function vaultServiceReadLabel(
  { service, limit }: VaultServiceRead,
  resolve: MFunctionType = mFallback,
) {
  switch (service) {
    case "github":
      return resolve(msg("List GitHub repositories (up to {limit})", { limit }));
    case "gitlab":
      return resolve(msg("List GitLab membership projects (up to {limit})", { limit }));
    case "slack":
      return resolve(msg("List Slack public channels (up to {limit})", { limit }));
    case "airtable":
      return resolve(msg("List Airtable bases (up to {limit})", { limit }));
    case "asana":
      return resolve(msg("List Asana workspaces (up to {limit})", { limit }));
    case "linear":
      return resolve(msg("List Linear teams (up to {limit})", { limit }));
    case "netlify":
      return resolve(msg("List Netlify sites (up to {limit})", { limit }));
    case "notion":
      return resolve(msg("List shared Notion pages (up to {limit})", { limit }));
    case "todoist":
      return resolve(msg("List Todoist projects (up to {limit})", { limit }));
    case "typeform":
      return resolve(msg("List Typeform forms (up to {limit})", { limit }));
    case "vercel":
      return resolve(msg("List Vercel projects (up to {limit})", { limit }));
  }
}

/** Tell the user what the agent can read after this particular approval. */
export const secretRequestPrivacyNote = (
  item: Pick<SecretRequestItem, "delivery" | "fields" | "taggedVault">,
  resolve: MFunctionType = mFallback,
) => {
  if (item.taggedVault && "gmail" in item.taggedVault) {
    return resolve(
      msg(
        "Only you see the listed email details. The agent receives the message count, not the messages.",
      ),
    );
  }
  if (item.taggedVault && "serviceRead" in item.taggedVault) {
    return resolve(
      msg("Only you see the list. The agent receives the item count, not the contents."),
    );
  }
  return item.delivery !== "file"
    ? resolve(msg("Stored securely, never shown to the agent"))
    : item.fields === undefined
      ? resolve(
          msg("Kept out of chat, in a private file this agent's commands can read for 24 hours"),
        )
      : resolve(
          msg("Kept out of chat, in private files this agent's commands can read for 24 hours"),
        );
};
const SECRET_REQUEST_DEFAULT_PLACEHOLDER = msg("Paste the secret");

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
  resolve: MFunctionType = mFallback,
): ReadonlyArray<SecretRequestInput> {
  if (item.fields === undefined) {
    return [
      {
        key: "",
        label: item.label,
        placeholder: item.placeholder ?? resolve(SECRET_REQUEST_DEFAULT_PLACEHOLDER),
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

// Backticks, <angle brackets> and markdown link targets (balanced parentheses allowed) keep their
// exact text; a bare link drops trailing sentence punctuation.
const REASON_LINK =
  /`(https?:\/\/[^`\s]+)`|<(https?:\/\/[^>\s]+)>|\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>"'`[\]]+)/giu;
/** Drops trailing sentence punctuation; a `)` stays when the link opened a matching `(`. */
function trimPunctuation(link: string): string {
  let end = link.length;
  while (end > 0 && ".,;:!?)".includes(link[end - 1]!)) {
    const kept = link.slice(0, end);
    if (link[end - 1] === ")" && kept.split("(").length > kept.split(")").length - 1) break;
    end -= 1;
  }
  return link.slice(0, end);
}

/** Drops a closing `*` or `_` run only when the same run opened emphasis before the link and is still open. */
function trimEmphasis(link: string, before: string) {
  const run = /(\*{1,3}|_{1,3})$/u.exec(link)?.[1];
  if (run === undefined) return link;
  const escaped = run.replaceAll("*", "\\*");
  // Nested emphasis (`**_url_**`) opens one run right after another.
  const opener = [...before.matchAll(new RegExp(`(?:^|[\\s(*_])${escaped}(?=\\S|$)`, "gu"))].at(-1);
  if (opener === undefined) return link;
  const closed = new RegExp(`\\S${escaped}(?:[\\s.,;:!?)]|$)`, "u").test(
    before.slice(opener.index + opener[0].length),
  );
  return closed ? link : trimPunctuation(link.slice(0, -run.length));
}

/** The one distinct http(s) link in `reason`, for agents that put it there instead of in `url`. */
function reasonLink(reason: string): string | undefined {
  const raw = Array.from(reason.matchAll(REASON_LINK), (match) => {
    const [, ticked, angled, target, bare] = match;
    if (bare === undefined) return ticked ?? angled ?? target ?? "";
    const before = reason.slice(0, match.index);
    let link = trimPunctuation(bare);
    for (let next = trimEmphasis(link, before); next !== link; next = trimEmphasis(link, before)) {
      link = next;
    }
    return link;
  });
  // Two spellings of one page (`https://a.dev` and `https://a.dev/`) count once.
  const links = new Set(raw.map((link) => secretRequestPageUrl(link)?.href ?? link));
  return links.size === 1 ? [...links][0] : undefined;
}

/** Only http(s), so an agent cannot make the card open another scheme. */
export function secretRequestLink(item: Pick<SecretRequestItem, "url" | "reason">) {
  const raw = item.url ?? reasonLink(item.reason);
  const url = raw === undefined ? null : secretRequestPageUrl(raw);
  return url === null ? null : { href: url.href, host: url.host };
}

export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus"> &
    Partial<Pick<SecretRequestItem, "id" | "taggedVault">>,
  visibility: "local" | "inherited" | "synthetic",
  resolve: MFunctionType = mFallback,
): SecretRequestDisplay {
  const status =
    item.secretStatus === "pending" && isRetiredVaultOperation(item.id)
      ? "cancelled"
      : item.secretStatus;
  switch (status) {
    case "pending":
      return visibility === "local"
        ? PENDING_DISPLAY
        : {
            kind: "pending-elsewhere",
            label: resolve(msg("Waiting for an answer in the original thread")),
          };
    case "saved":
      return {
        kind: "answered",
        outcome: "saved",
        label:
          item.taggedVault && "gmail" in item.taggedVault
            ? resolve(msg("Gmail read approved"))
            : item.taggedVault && "serviceRead" in item.taggedVault
              ? resolve(msg("Private read approved"))
              : resolve(msg("Saved securely and kept private")),
      };
    case "declined":
      return { kind: "answered", outcome: "declined", label: resolve(msg("Declined")) };
    case "cancelled":
      return { kind: "answered", outcome: "ended", label: resolve(msg("Request ended")) };
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

// Secret provider packages author this text in English; the same English, translatable here.
const INVALID_REFERENCE_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "Use a 1Password reference like op://vault/item/field.",
    msg("Use a 1Password reference like {example}.", { example: "op://vault/item/field" }),
  ],
]);

/** A secret provider's `invalidReferenceMessage` in the UI language when it is a known one. */
export function invalidSecretReferenceText(
  message: string,
  resolve: MFunctionType = mFallback,
): string {
  const translated = INVALID_REFERENCE_MESSAGES.get(message);
  return translated === undefined ? message : resolve(translated);
}
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
  resolve: MFunctionType = mFallback,
): ReadonlyArray<SecretRequestSource> {
  if (config?.secretRequestReferences !== true) return NO_SOURCES;
  return configuredSecretSources(providers, resolve);
}

export function configuredSecretSources(
  providers: ServerSettings["secretProviders"],
  resolve: MFunctionType = mFallback,
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
        invalidReferenceMessage: invalidSecretReferenceText(
          definition.invalidReferenceMessage,
          resolve,
        ),
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
  | {
      readonly type: "vault";
      readonly pin: Redacted.Redacted<string>;
    }
  | {
      readonly type: "vault_display";
      readonly pin: Redacted.Redacted<string>;
      readonly account: string;
    }
  | { readonly type: "decline" };

/** Null until every input has a value, or while a reference is not `source`'s syntax. */
export function secretRequestAnswerInput(
  item: Pick<
    SecretRequestItem,
    "id" | "threadId" | "label" | "placeholder" | "fields" | "taggedVault" | "delivery"
  >,
  answer: SecretRequestReply,
): SecretRequestAnswerInput | null {
  const base = { threadId: item.threadId, turnItemId: item.id };
  if (answer.type === "decline") return { ...base, answer: { type: "decline" } };
  if (answer.type === "vault" || answer.type === "vault_display") {
    const entry = item.taggedVault;
    if (!entry || item.delivery || item.fields) return null;
    if (answer.type === "vault_display")
      return "field" in entry || !answer.account.trim()
        ? null
        : {
            ...base,
            answer: {
              type: "gmail" in entry ? "vault_gmail_display" : "vault_service_display",
              name: entry.name,
              account: answer.account,
              pin: answer.pin,
            },
          };
    if (!("field" in entry)) return null;
    return {
      ...base,
      answer: {
        type: "vault",
        name: entry.name,
        fields: { value: entry.field },
        pin: answer.pin,
      },
    };
  }
  if (item.taggedVault) return null;
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
export function secretRequestFailureMessage(
  failure: unknown,
  resolve: MFunctionType = mFallback,
): string {
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
    return errorDisplayMessage(failure, resolve) ?? failure.message;
  }
  return resolve(msg("Could not answer the request. Try again."));
}
