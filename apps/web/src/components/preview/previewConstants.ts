import type { MessageKey } from "@t3tools/client-runtime/i18n";

export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, MessageKey>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "review.preview.error.dnsNotFound",
  ERR_NAME_RESOLUTION_FAILED: "review.preview.error.dnsNotFound",
  ERR_CONNECTION_REFUSED: "review.preview.error.connectionRefused",
  ERR_CONNECTION_RESET: "review.preview.error.connectionReset",
  ERR_CONNECTION_CLOSED: "review.preview.error.connectionClosed",
  ERR_CONNECTION_TIMED_OUT: "review.preview.error.timedOut",
  ERR_INTERNET_DISCONNECTED: "review.preview.error.noInternet",
  ERR_TIMED_OUT: "review.preview.error.timedOut",
  ERR_CERT_AUTHORITY_INVALID: "review.preview.error.certAuthority",
  ERR_CERT_COMMON_NAME_INVALID: "review.preview.error.certHostname",
  ERR_CERT_DATE_INVALID: "review.preview.error.certDate",
  ERR_TOO_MANY_REDIRECTS: "review.preview.error.tooManyRedirects",
});
