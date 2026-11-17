import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";
import { SecretProviderId } from "./secretReference.ts";

/** Which secret provider and vault the in-app browser fills logins from. Absent turns it off. */
export const BrowserLoginsSettings = Schema.Struct({
  provider: SecretProviderId,
  vault: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type BrowserLoginsSettings = typeof BrowserLoginsSettings.Type;

export const BROWSER_LOGIN_FIELDS = ["username", "password", "otp"] as const;
export const BrowserLoginField = Schema.Literals(BROWSER_LOGIN_FIELDS);
export type BrowserLoginField = typeof BrowserLoginField.Type;

export const BrowserLoginItemId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9]+$/),
);

export const BrowserLogin = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  urls: Schema.Array(Schema.String),
  fields: Schema.Array(BrowserLoginField).annotate({
    description: "Fields this login can fill. Values are never returned.",
  }),
});
export type BrowserLogin = typeof BrowserLogin.Type;

export const BrowserLoginsList = Schema.Struct({
  origin: Schema.NullOr(Schema.String).annotate({
    description:
      "The page origin logins were matched against; null when the page cannot take a login (not https, nor http on localhost).",
  }),
  logins: Schema.Array(BrowserLogin),
});
export type BrowserLoginsList = typeof BrowserLoginsList.Type;

export const BrowserLoginErrorReason = Schema.Literals([
  "notConfigured",
  "providerUnsupported",
  "providerUnavailable",
  "vaultNotFound",
  "itemNotFound",
  "fieldMissing",
  "originMismatch",
  "crossOriginFrame",
  "fillFailed",
  "tabNotFound",
  "agentControl",
  "notPasswordField",
]);
export type BrowserLoginErrorReason = typeof BrowserLoginErrorReason.Type;

const BROWSER_LOGIN_ERROR_MESSAGES: Record<BrowserLoginErrorReason, string> = {
  notConfigured:
    "Browser logins are off in this environment. The user turns them on with `browserLogins` in the server's settings.json. Do not retry.",
  providerUnsupported:
    "The secret provider chosen for browser logins cannot list logins. Do not retry.",
  providerUnavailable:
    "The login vault could not be read. Its password manager may be locked or signed out on the server's machine; ask the user to unlock it, then retry once.",
  vaultNotFound:
    "The vault chosen for browser logins does not exist in the secret provider's account. Ask the user to fix `browserLogins.vault`.",
  itemNotFound:
    "No login with this id is in the browser login vault. Call preview_logins for the page that is open now.",
  fieldMissing: "This login has no such field. Fill only fields preview_logins listed for it.",
  originMismatch:
    "This login is not for the page that is open now. Call preview_logins again before filling.",
  crossOriginFrame:
    "The target field is in a frame from another origin. Logins fill only fields in the page's own origin.",
  fillFailed:
    "The login was not filled: the locator did not resolve to one enabled, visible text field in time. Take a fresh snapshot and pass that field's locator.",
  tabNotFound: "This browser tab is not open.",
  agentControl: "An agent controls this browser tab. Take control of it, then fill the login.",
  notPasswordField:
    "A password fills only an <input type=password>. Take a fresh snapshot and pass the password field's locator.",
};

/** Never carries a secret value: every message is fixed text chosen by the reason. */
export class BrowserLoginError extends Schema.TaggedError<BrowserLoginError>()(
  "BrowserLoginError",
  { reason: BrowserLoginErrorReason },
) {
  override get message(): string {
    return BROWSER_LOGIN_ERROR_MESSAGES[this.reason];
  }
}

const BrowserLoginsTabFields = { threadId: ThreadId, tabId: PreviewTabId };

export const BrowserLoginsListForTabInput = Schema.Struct(BrowserLoginsTabFields);
export type BrowserLoginsListForTabInput = typeof BrowserLoginsListForTabInput.Type;

/** `login` fills the username and password fields found on the page, `otp` the one-time code field. */
export const BrowserLoginFillKind = Schema.Literals(["login", "otp"]);
export type BrowserLoginFillKind = typeof BrowserLoginFillKind.Type;

export const BrowserLoginsFillForTabInput = Schema.Struct({
  ...BrowserLoginsTabFields,
  itemId: BrowserLoginItemId,
  fill: BrowserLoginFillKind,
});
export type BrowserLoginsFillForTabInput = typeof BrowserLoginsFillForTabInput.Type;

/** Which fields were filled and which were not found on the page or in the login. Never values. */
export const BrowserLoginsFillResult = Schema.Struct({
  filled: Schema.Array(BrowserLoginField),
  missing: Schema.Array(BrowserLoginField),
});
export type BrowserLoginsFillResult = typeof BrowserLoginsFillResult.Type;

export const BrowserLoginVault = Schema.Struct({ id: Schema.String, name: Schema.String });
export type BrowserLoginVault = typeof BrowserLoginVault.Type;

export const BrowserLoginsListVaultsInput = Schema.Struct({ provider: SecretProviderId });
export type BrowserLoginsListVaultsInput = typeof BrowserLoginsListVaultsInput.Type;

export const BrowserLoginsListVaultsResult = Schema.Struct({
  /** Null when the provider cannot list vaults, as with 1Password Connect; type the name instead. */
  vaults: Schema.NullOr(Schema.Array(BrowserLoginVault)),
});
export type BrowserLoginsListVaultsResult = typeof BrowserLoginsListVaultsResult.Type;

export const BrowserLoginsCheckInput = BrowserLoginsSettings;
export type BrowserLoginsCheckInput = typeof BrowserLoginsCheckInput.Type;

export const BrowserLoginsCheckResult = Schema.Struct({ logins: Schema.Int });
export type BrowserLoginsCheckResult = typeof BrowserLoginsCheckResult.Type;
