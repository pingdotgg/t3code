import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const LocalVaultName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384));
const title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
export const LocalVaultField = Schema.Literals(["token", "username", "password", "note"]);
export type LocalVaultField = typeof LocalVaultField.Type;

export const VAULT_TOKEN_SERVICES = [
  "github",
  "gitlab",
  "slack",
  "airtable",
  "asana",
  "linear",
  "netlify",
  "notion",
  "todoist",
  "typeform",
  "vercel",
] as const;
export const VaultTokenService = Schema.Literals(VAULT_TOKEN_SERVICES);
export type VaultTokenService = typeof VaultTokenService.Type;
export const VaultConnectionSecretText = Schema.String.check(
  Schema.isPattern(/^[\x21-\x7e]{1,4096}$/u),
);
const validConnectionSecret = Schema.is(VaultConnectionSecretText);
const redactedConnectionSecret = Schema.Redacted(Schema.String).check(
  Schema.makeFilter(
    (value) =>
      validConnectionSecret(Redacted.value(value)) ||
      "Expected a credential of 1 to 4096 printable non-space ASCII characters.",
  ),
);
export const VaultCredentialService = Schema.Literals(["gmail", ...VAULT_TOKEN_SERVICES]);
export type VaultCredentialService = typeof VaultCredentialService.Type;
export const VAULT_SERVICE_LABELS = {
  gmail: "Gmail",
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  airtable: "Airtable",
  asana: "Asana",
  linear: "Linear",
  netlify: "Netlify",
  notion: "Notion",
  todoist: "Todoist",
  typeform: "Typeform",
  vercel: "Vercel",
} as const satisfies Record<VaultCredentialService, string>;
export const VAULT_SERVICE_RESOURCES = {
  github: "GitHub repositories",
  gitlab: "GitLab membership projects",
  slack: "public Slack channels",
  airtable: "Airtable bases",
  asana: "Asana workspaces",
  linear: "Linear teams",
  netlify: "Netlify sites",
  notion: "shared Notion pages",
  todoist: "Todoist projects",
  typeform: "Typeform forms",
  vercel: "Vercel projects",
} as const satisfies Record<VaultTokenService, string>;
export const VAULT_SERVICE_MAX_ITEMS = 20;
export const VaultServiceRead = Schema.Struct({
  service: VaultTokenService,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: VAULT_SERVICE_MAX_ITEMS })),
});
export type VaultServiceRead = typeof VaultServiceRead.Type;
export const VaultServiceItem = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type VaultServiceItem = typeof VaultServiceItem.Type;

export const GmailClientId = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/u),
);
export const GMAIL_CALLBACK_PATH = "/oauth/gmail/callback";
const gmailClientFields = {
  clientId: GmailClientId,
  redirectUri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
};
export const GMAIL_MAX_MESSAGES = 20;
export const GMAIL_SUMMARY_MAX_LENGTH = {
  from: 320,
  subject: 512,
  date: 128,
  snippet: 512,
} as const;
export const GmailReadOperation = Schema.Struct({
  folder: Schema.Literals(["inbox", "spam"]),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: GMAIL_MAX_MESSAGES })),
});
export type GmailReadOperation = typeof GmailReadOperation.Type;
export const GmailMessageSummary = Schema.Struct({
  from: Schema.String.check(Schema.isMaxLength(GMAIL_SUMMARY_MAX_LENGTH.from)),
  subject: Schema.String.check(Schema.isMaxLength(GMAIL_SUMMARY_MAX_LENGTH.subject)),
  date: Schema.String.check(Schema.isMaxLength(GMAIL_SUMMARY_MAX_LENGTH.date)),
  snippet: Schema.String.check(Schema.isMaxLength(GMAIL_SUMMARY_MAX_LENGTH.snippet)),
});
export type GmailMessageSummary = typeof GmailMessageSummary.Type;
export const LocalVaultRecord = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("token"), title, token: text }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("login"),
    title,
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    username: text,
    password: text,
  }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("note"), title, note: text }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("gmail"), title }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("service"), title }),
]);
export type LocalVaultRecord = typeof LocalVaultRecord.Type;
export const VaultAccessMode = Schema.Literals(["ask", "allow"]);
export type VaultAccessMode = typeof VaultAccessMode.Type;
export const VaultPin = Schema.Redacted(Schema.String);
export const VaultSecurityStatus = Schema.Struct({
  configured: Schema.Boolean,
  canSetInitialPin: Schema.Boolean,
  retryAt: Schema.Number,
});
export const VaultConnectionRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const LocalVaultEntry = Schema.Struct({
  name: LocalVaultName,
  title,
  kind: Schema.Literals(["token", "login", "note", "gmail", "service"]),
  fields: Schema.Array(LocalVaultField),
  access: Schema.optionalKey(VaultAccessMode),
  origin: Schema.optionalKey(Schema.String),
  gmailClient: Schema.optionalKey(Schema.Struct(gmailClientFields)),
  gmailAccount: Schema.optionalKey(Schema.String),
  serviceConnection: Schema.optionalKey(
    Schema.Struct({
      service: VaultTokenService,
      account: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
      revision: Schema.optionalKey(VaultConnectionRevision),
    }),
  ),
}).check(
  Schema.makeFilter((entry) => {
    if (entry.kind === "service")
      return (
        (entry.fields.length === 0 &&
          !!entry.serviceConnection &&
          !entry.gmailClient &&
          !entry.gmailAccount) ||
        "Service credentials describe one connection and have no exportable fields."
      );
    return (
      (!entry.serviceConnection && (entry.kind !== "gmail" || entry.fields.length === 0)) ||
      "The connection does not match the credential type."
    );
  }),
);
export type LocalVaultEntry = typeof LocalVaultEntry.Type;
export const TaggedVaultEntry = Schema.Union([
  Schema.Struct({ name: LocalVaultName, field: LocalVaultField }),
  Schema.Struct({
    name: LocalVaultName,
    gmail: GmailReadOperation,
    needsGmailConnection: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    name: LocalVaultName,
    serviceRead: VaultServiceRead,
    revision: Schema.optionalKey(VaultConnectionRevision),
  }),
]);
export type TaggedVaultEntry = typeof TaggedVaultEntry.Type;

export const vaultMentionLabel = (title: string) =>
  title
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .trim();

const vaultMentionPattern =
  /(?<![^\s,([\x22'])vault:("(?:[^"\\\p{Cc}\p{Zl}\p{Zp}]|\\["\\]){1,240}")(?=$|[\s.,!?;:)\]])/gu;

export function collectVaultMentions(text: string) {
  if (!text.includes('vault:"')) return [];
  return Array.from(text.matchAll(vaultMentionPattern)).flatMap((match) => {
    const label = JSON.parse(match[1]!) as string;
    if (!label.trim() || label.length > 120 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) return [];
    return [
      {
        type: "vault-credential" as const,
        label,
        source: match[0],
        start: match.index,
        end: match.index + match[0].length,
      },
    ];
  });
}

export const LocalVaultInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("set-pin"),
    pin: Schema.optionalKey(VaultPin),
    newPin: VaultPin,
  }),
  Schema.Struct({
    action: Schema.Literal("save"),
    name: LocalVaultName,
    value: Schema.Redacted(text),
    replace: Schema.Boolean,
    structured: Schema.optionalKey(Schema.Boolean),
    pin: Schema.optionalKey(VaultPin),
    access: Schema.optionalKey(VaultAccessMode),
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    name: LocalVaultName,
    pin: Schema.optionalKey(VaultPin),
  }),
  Schema.Struct({
    action: Schema.Literal("connect-service"),
    name: LocalVaultName,
    title,
    service: VaultTokenService,
    token: redactedConnectionSecret,
    pin: VaultPin,
  }),
  Schema.Struct({
    action: Schema.Literal("gmail-configure"),
    name: LocalVaultName,
    title,
    ...gmailClientFields,
    clientSecret: Schema.optionalKey(redactedConnectionSecret),
    pin: VaultPin,
  }),
  Schema.Struct({ action: Schema.Literal("gmail-start"), name: LocalVaultName, title }),
  Schema.Struct({
    action: Schema.Literal("gmail-finish"),
    name: LocalVaultName,
    flowId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    pin: VaultPin,
  }),
  Schema.Struct({
    action: Schema.Literal("gmail-disconnect"),
    name: LocalVaultName,
    pin: VaultPin,
  }),
]);
export type LocalVaultInput = typeof LocalVaultInput.Type;
export const LocalVaultResult = Schema.Struct({
  names: Schema.Array(LocalVaultName),
  entries: Schema.optionalKey(Schema.Array(LocalVaultEntry)),
  security: Schema.optionalKey(VaultSecurityStatus),
  credentialServices: Schema.optionalKey(Schema.Array(VaultCredentialService)),
  gmailAvailable: Schema.optionalKey(Schema.Boolean),
  gmailUserCredentials: Schema.optionalKey(Schema.Literal(true)),
  gmailRedirectUri: Schema.optionalKey(Schema.String),
  gmailAuthorization: Schema.optionalKey(
    Schema.Struct({ url: Schema.String, flowId: Schema.String }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type LocalVaultResult = typeof LocalVaultResult.Type;
export const LOCAL_VAULT_PROVIDER = "hyakki-vault";
export function localVaultReference(name: string, field: LocalVaultField): string {
  return `hyakki-vault://${name}/${field}`;
}
export function parseLocalVaultReference(
  reference: string,
): { readonly name: string; readonly field: LocalVaultField } | undefined {
  const match =
    /^hyakki-vault:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/(token|username|password|note)$/.exec(
      reference,
    );
  return match ? { name: match[1]!, field: match[2]! as LocalVaultField } : undefined;
}
