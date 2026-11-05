import { t } from "@palamedes/core/macro";
export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  get ERR_NAME_NOT_RESOLVED() {
    return t({ message: "DNS address could not be found" });
  },
  get ERR_NAME_RESOLUTION_FAILED() {
    return t({ message: "DNS address could not be found" });
  },
  get ERR_CONNECTION_REFUSED() {
    return t({ message: "Connection refused" });
  },
  get ERR_CONNECTION_RESET() {
    return t({ message: "Connection was reset" });
  },
  get ERR_CONNECTION_CLOSED() {
    return t({ message: "Connection was closed" });
  },
  get ERR_CONNECTION_TIMED_OUT() {
    return t({ message: "Connection timed out" });
  },
  get ERR_INTERNET_DISCONNECTED() {
    return t({ message: "No internet connection" });
  },
  get ERR_TIMED_OUT() {
    return t({ message: "Connection timed out" });
  },
  get ERR_CERT_AUTHORITY_INVALID() {
    return t({ message: "Certificate authority is not trusted" });
  },
  get ERR_CERT_COMMON_NAME_INVALID() {
    return t({ message: "Certificate hostname mismatch" });
  },
  get ERR_CERT_DATE_INVALID() {
    return t({ message: "Certificate is expired or not yet valid" });
  },
  get ERR_TOO_MANY_REDIRECTS() {
    return t({ message: "Too many redirects" });
  },
});
