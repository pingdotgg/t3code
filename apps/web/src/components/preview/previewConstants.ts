import { msg } from "gt-react";

export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: msg("DNS address could not be found"),
  ERR_NAME_RESOLUTION_FAILED: msg("DNS address could not be found"),
  ERR_CONNECTION_REFUSED: msg("Connection refused"),
  ERR_CONNECTION_RESET: msg("Connection was reset"),
  ERR_CONNECTION_CLOSED: msg("Connection was closed"),
  ERR_CONNECTION_TIMED_OUT: msg("Connection timed out"),
  ERR_INTERNET_DISCONNECTED: msg("No internet connection"),
  ERR_TIMED_OUT: msg("Connection timed out"),
  ERR_CERT_AUTHORITY_INVALID: msg("Certificate authority is not trusted"),
  ERR_CERT_COMMON_NAME_INVALID: msg("Certificate hostname mismatch"),
  ERR_CERT_DATE_INVALID: msg("Certificate is expired or not yet valid"),
  ERR_TOO_MANY_REDIRECTS: msg("Too many redirects"),
});
