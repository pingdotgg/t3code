import { Effect, Schema } from "effect";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

/**
 * Password-manager autofill for the collaborative browser. Agents see only item metadata
 * and fill statuses; test-login values go from the server store to the desktop's CDP
 * session in trusted code. Personal Vault logins stay on the desktop.
 */

export const CredentialField = Schema.Literals(["username", "password", "otp"]);
export type CredentialField = typeof CredentialField.Type;

/** Login ids, including the legacy id format accepted by older clients. */
export const CredentialItemId = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-z0-9]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  ),
).annotate({ description: "Item id from request_credentials." });
export type CredentialItemId = typeof CredentialItemId.Type;

/**
 * Where a saved login lives. `test` logins are T3 Code's own store for test
 * users of sites you develop: they fill without a prompt and agents may save them.
 */
export const CredentialSource = Schema.Literals(["test", "vault"]);
export type CredentialSource = typeof CredentialSource.Type;

export const CredentialItemSummary = Schema.Struct({
  id: CredentialItemId,
  title: Schema.String,
  urls: Schema.Array(Schema.String),
  source: Schema.optional(CredentialSource),
  /** Only test logins are exposed to agents. */
  username: Schema.optional(Schema.String),
});
export type CredentialItemSummary = typeof CredentialItemSummary.Type;

export const RequestCredentialsInput = Schema.Struct({
  domain: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(253))
    .annotate({
      description:
        "Site to sign in to: a host such as github.com, or the full URL of the sign-in page.",
    }),
});
export type RequestCredentialsInput = typeof RequestCredentialsInput.Type;

export const RequestCredentialsResult = Schema.Struct({
  items: Schema.Array(CredentialItemSummary),
});
export type RequestCredentialsResult = typeof RequestCredentialsResult.Type;

export const FillCredentialInput = Schema.Struct({
  itemId: CredentialItemId,
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description: "Browser tab to fill. Omit to use this agent session's current tab.",
    }),
  ),
  field: CredentialField.annotate({
    description: "Which value to fill: username, password, or otp (one-time code).",
  }),
  selector: Schema.optional(
    Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(512)).annotate({
      description:
        "Optional CSS selector for the input. Omit to let Conn find the field for this credential type.",
    }),
  ),
});
export type FillCredentialInput = typeof FillCredentialInput.Type;

/**
 * The only thing an agent learns from a fill. Every value is a fixed token,
 * so no page or password-manager text can ride along.
 */
export const CredentialFillStatus = Schema.Literals([
  "filled",
  "denied",
  "tab_unavailable",
  "origin_mismatch",
  "field_not_found",
  "not_editable",
  "insert_failed",
  "item_not_found",
  "no_value",
  "provider_unavailable",
]);
export type CredentialFillStatus = typeof CredentialFillStatus.Type;

export const FillCredentialResult = Schema.Struct({
  status: CredentialFillStatus,
  message: Schema.String,
});
export type FillCredentialResult = typeof FillCredentialResult.Type;

/** Broker input for the desktop's approval prompt. Holds no secret. */
export const CredentialApprovalRequest = Schema.Struct({
  itemTitle: Schema.String,
  providerLabel: Schema.String,
  origin: Schema.String,
  /** The field the agent asked to fill. */
  field: CredentialField,
  /**
   * Set when one approval may cover a whole sign-in: the fields the user can
   * allow at once, the requested one included.
   */
  signInFields: Schema.optional(Schema.Array(CredentialField)),
  /** How long a granted sign-in lasts, for the prompt's copy. */
  signInSeconds: Schema.optional(Schema.Int),
  /** The prompt denies by itself after this many seconds. */
  timeoutSeconds: Schema.optional(Schema.Int),
  /** Evaluates in the page to the input that will be filled, to highlight it. */
  fieldExpression: Schema.optional(Schema.String),
});
export type CredentialApprovalRequest = typeof CredentialApprovalRequest.Type;

export const CredentialApprovalDecision = Schema.Struct({
  approved: Schema.Boolean,
  /** For a sign-in prompt: the fields the user allowed. */
  fields: Schema.optional(Schema.Array(CredentialField)),
});
export type CredentialApprovalDecision = typeof CredentialApprovalDecision.Type;

/** Desktop-side outcome of one fill. A subset of CredentialFillStatus. */
export const DesktopCredentialFillStatus = Schema.Literals([
  "filled",
  "origin_mismatch",
  "field_not_found",
  "not_editable",
  "insert_failed",
]);
export type DesktopCredentialFillStatus = typeof DesktopCredentialFillStatus.Type;

export const DesktopCredentialFillResult = Schema.Struct({
  status: DesktopCredentialFillStatus,
});
export type DesktopCredentialFillResult = typeof DesktopCredentialFillResult.Type;

const CREDENTIAL_APPROVAL_TIMEOUT_SECONDS = [30, 90, 180] as const;

export const CredentialAutofillSettings = Schema.Struct({
  /** One prompt covers every field of one login on one site and tab, briefly. */
  oneApprovalPerSignIn: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** An unanswered prompt counts as denied after this many seconds. */
  approvalTimeoutSeconds: Schema.Literals(CREDENTIAL_APPROVAL_TIMEOUT_SECONDS).pipe(
    Schema.withDecodingDefault(Effect.succeed(90 as const)),
  ),
  /** After a password or code fill, refuse agent JavaScript in that tab until it navigates. */
  blockScriptsAfterFill: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** A test login saved for example.com also fills its subdomains. */
  allowSubdomains: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CredentialAutofillSettings = typeof CredentialAutofillSettings.Type;

export const CredentialAutofillSettingsPatch = Schema.Struct({
  oneApprovalPerSignIn: Schema.optionalKey(Schema.Boolean),
  approvalTimeoutSeconds: Schema.optionalKey(Schema.Literals(CREDENTIAL_APPROVAL_TIMEOUT_SECONDS)),
  blockScriptsAfterFill: Schema.optionalKey(Schema.Boolean),
  allowSubdomains: Schema.optionalKey(Schema.Boolean),
});

/** A saved login offered in the browser's own key menu. Shown to the user only. */
export const SiteCredentialOption = Schema.Struct({
  id: CredentialItemId,
  title: Schema.String,
  /** The username hint shown in the login picker. */
  username: Schema.NullOr(Schema.String),
  source: CredentialSource,
});
export type SiteCredentialOption = typeof SiteCredentialOption.Type;

export const ListSiteCredentialsInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(4096)),
});
export type ListSiteCredentialsInput = typeof ListSiteCredentialsInput.Type;

export const ListSiteCredentialsResult = Schema.Struct({
  /** The tab origin the logins match, or null when nothing matches. */
  origin: Schema.NullOr(Schema.String),
  items: Schema.Array(SiteCredentialOption),
  /** Set when the test-login store could not be read. */
  unavailable: Schema.NullOr(Schema.String),
});
export type ListSiteCredentialsResult = typeof ListSiteCredentialsResult.Type;

/**
 * The user picked a test login in the browser's key menu. Runs without a
 * prompt. The environment's browser fills its own tab; Vault logins never
 * come here, the desktop fills them itself.
 */
export const FillSiteCredentialInput = Schema.Struct({
  /** Distinguishes Vault UUIDs from test-login UUIDs. The server refuses Vault items. */
  source: Schema.optional(CredentialSource),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
  itemId: CredentialItemId,
  fields: Schema.Array(CredentialField).check(Schema.isMinLength(1)).check(Schema.isMaxLength(3)),
});
export type FillSiteCredentialInput = typeof FillSiteCredentialInput.Type;

export const FillSiteCredentialResult = Schema.Struct({
  results: Schema.Array(Schema.Struct({ field: CredentialField, status: CredentialFillStatus })),
});
export type FillSiteCredentialResult = typeof FillSiteCredentialResult.Type;

const TestLoginText = Schema.String.check(Schema.isMaxLength(1024));

/** A test login as lists show it: no password or one-time code secret. */
export const TestLoginSummary = Schema.Struct({
  id: CredentialItemId,
  label: Schema.String,
  url: Schema.String,
  username: Schema.String,
  hasOtp: Schema.Boolean,
  createdAt: Schema.String,
  createdBy: Schema.Literals(["user", "agent"]),
});
export type TestLoginSummary = typeof TestLoginSummary.Type;

export const SaveTestLoginInput = Schema.Struct({
  url: TestLoginText.check(Schema.isNonEmpty()).annotate({
    description: "Sign-in page or site of the test user, for example http://myapp.test/login.",
  }),
  username: TestLoginText.check(Schema.isNonEmpty()),
  password: TestLoginText,
  label: Schema.optional(
    TestLoginText.annotate({ description: "Short name such as admin or customer." }),
  ),
  otpSecret: Schema.optional(
    TestLoginText.annotate({
      description:
        "Base32 TOTP secret or otpauth:// URI, when the test user has two-factor sign-in.",
    }),
  ),
});
export type SaveTestLoginInput = typeof SaveTestLoginInput.Type;

export const UpdateTestLoginInput = Schema.Struct({
  id: CredentialItemId,
  url: Schema.optional(TestLoginText.check(Schema.isNonEmpty())),
  username: Schema.optional(TestLoginText.check(Schema.isNonEmpty())),
  password: Schema.optional(TestLoginText),
  label: Schema.optional(TestLoginText),
  /** null removes the one-time code secret. */
  otpSecret: Schema.optional(Schema.NullOr(TestLoginText)),
});
export type UpdateTestLoginInput = typeof UpdateTestLoginInput.Type;

export const TestLoginIdInput = Schema.Struct({ id: CredentialItemId });
export type TestLoginIdInput = typeof TestLoginIdInput.Type;

/** The stored secrets of one test login, for the user's own edit form. */
export const TestLoginSecrets = Schema.Struct({
  password: Schema.String,
  otpSecret: Schema.NullOr(Schema.String),
});
export type TestLoginSecrets = typeof TestLoginSecrets.Type;

export const TestLoginList = Schema.Struct({ items: Schema.Array(TestLoginSummary) });
export type TestLoginList = typeof TestLoginList.Type;

export class TestLoginNotFoundError extends Schema.TaggedError<TestLoginNotFoundError>()(
  "TestLoginNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return "No test login with this id.";
  }
}

export class TestLoginStoreError extends Schema.TaggedError<TestLoginStoreError>()(
  "TestLoginStoreError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Conn could not read or save its test logins.";
  }
}
