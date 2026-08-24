import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";
import type { Translate } from "~/i18n";

/**
 * Resolve a friendly description for a Chromium / network error. Falls back
 * to the description string passed in when it isn't in our table.
 */
export function describePreviewError(description: string, t?: Translate): string {
  if (t) {
    switch (description) {
      case "ERR_NAME_NOT_RESOLVED":
      case "ERR_NAME_RESOLUTION_FAILED":
        return t("preview.error.dnsNotFound");
      case "ERR_CONNECTION_REFUSED":
        return t("preview.error.connectionRefused");
      case "ERR_CONNECTION_RESET":
        return t("preview.error.connectionReset");
      case "ERR_CONNECTION_CLOSED":
        return t("preview.error.connectionClosed");
      case "ERR_CONNECTION_TIMED_OUT":
      case "ERR_TIMED_OUT":
        return t("preview.error.connectionTimedOut");
      case "ERR_INTERNET_DISCONNECTED":
        return t("preview.error.noInternet");
      case "ERR_CERT_AUTHORITY_INVALID":
        return t("preview.error.certificateAuthority");
      case "ERR_CERT_COMMON_NAME_INVALID":
        return t("preview.error.certificateHostname");
      case "ERR_CERT_DATE_INVALID":
        return t("preview.error.certificateDate");
      case "ERR_TOO_MANY_REDIRECTS":
        return t("preview.error.tooManyRedirects");
    }
  }
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return friendly;
  if (description.length > 0) return description;
  return t?.("preview.error.network") ?? "Network error";
}
