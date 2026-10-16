export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "DNS address could not be found",
  ERR_NAME_RESOLUTION_FAILED: "DNS address could not be found",
  ERR_CONNECTION_REFUSED: "Connection refused",
  ERR_CONNECTION_RESET: "Connection was reset",
  ERR_CONNECTION_CLOSED: "Connection was closed",
  ERR_CONNECTION_TIMED_OUT: "Connection timed out",
  ERR_INTERNET_DISCONNECTED: "No internet connection",
  ERR_TIMED_OUT: "Connection timed out",
  ERR_CERT_AUTHORITY_INVALID: "Certificate authority is not trusted",
  ERR_CERT_COMMON_NAME_INVALID: "Certificate hostname mismatch",
  ERR_CERT_DATE_INVALID: "Certificate is expired or not yet valid",
  ERR_TOO_MANY_REDIRECTS: "Too many redirects",
});
