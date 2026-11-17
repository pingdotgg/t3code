import type {
  BrowserLoginErrorReason,
  BrowserLoginField,
  BrowserLoginsFillResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin a login can fill, as the server decides it: https, or http on loopback. */
export function loginOriginOf(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.origin;
  return null;
}

// Whole sentences per field set, so no translation is built from fragments.
const FILLED: Record<string, string> = {
  username: msg("Filled username"),
  password: msg("Filled password"),
  "username,password": msg("Filled username and password"),
  otp: msg("Filled code"),
};

const MISSING: Record<string, string> = {
  username: msg("No username field found."),
  password: msg("No password field found."),
  "username,password": msg("No username or password field found."),
  otp: msg("No code field found."),
};

const fieldKey = (fields: ReadonlyArray<BrowserLoginField>) => [...fields].toSorted().join(",");

/** What a fill did, for a person: which fields were filled and which were not found. */
export function describeFill(
  result: BrowserLoginsFillResult,
  resolve: MessageResolver = m,
): {
  readonly type: "success" | "warning";
  readonly title: string;
  readonly description?: string;
} {
  const missingMessage = MISSING[fieldKey(result.missing)];
  const missing =
    result.missing.length === 0 || !missingMessage ? undefined : resolve(missingMessage);
  if (result.filled.length === 0) {
    return {
      type: "warning",
      title: resolve(msg("Nothing filled")),
      ...(missing ? { description: missing } : {}),
    };
  }
  return {
    type: missing ? "warning" : "success",
    title: resolve(FILLED[fieldKey(result.filled)] ?? msg("Filled the login")),
    ...(missing ? { description: missing } : {}),
  };
}

/** The server's reasons are written for agents; these are for the person at the panel. */
export const BROWSER_LOGIN_REASON_TEXT: Record<BrowserLoginErrorReason, string> = {
  notConfigured: msg("Browser logins are off. Turn them on in Settings → Secrets."),
  providerUnsupported: msg("This secret provider can't fill logins."),
  providerUnavailable: msg(
    "1Password couldn't be read. Unlock it on the server's machine and try again.",
  ),
  vaultNotFound: msg(
    "The vault chosen for browser logins doesn't exist. Choose another in Settings → Secrets.",
  ),
  itemNotFound: msg("This login is no longer in the vault."),
  fieldMissing: msg("This login has no such field."),
  originMismatch: msg("This login isn't for the page that's open now."),
  crossOriginFrame: msg("The field is in a frame from another site, so it wasn't filled."),
  fillFailed: msg("The field couldn't be filled."),
  tabNotFound: msg("This tab is no longer open."),
  agentControl: msg("An agent controls this tab. Take control, then fill the login."),
  notPasswordField: msg("The page changed while filling, so the password wasn't filled."),
};
