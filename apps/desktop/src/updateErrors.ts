import type { DesktopToastAction, DesktopUpdateState } from "@t3tools/contracts";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

const RETRY_DOWNLOAD_TOAST_ACTION: DesktopToastAction = {
  kind: "desktop-update.retry-download",
  label: "Retry download",
};

const NETWORK_ERROR_PATTERN =
  /\b(EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ERR_CONNECTION_(?:CLOSED|REFUSED|RESET|TIMED_OUT)|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|socket hang up)\b/i;
const CHECKSUM_ERROR_PATTERN =
  /\b(checksum|sha(?:256|512)?|hash)\b.*\b(mismatch|invalid|failed|different)\b|\b(mismatch|invalid|failed|different)\b.*\b(checksum|sha(?:256|512)?|hash)\b/i;

function formatDesktopUpdateRawError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getFallbackDesktopUpdateErrorMessage(context: DesktopUpdateErrorContext): string {
  if (context === "check") return "Couldn't check for updates.";
  if (context === "download") return "Couldn't download the update.";
  if (context === "install") return "Couldn't install the update.";
  return "Update failed.";
}

function isNetworkErrorMessage(message: string): boolean {
  return NETWORK_ERROR_PATTERN.test(message);
}

function isChecksumErrorMessage(message: string): boolean {
  return CHECKSUM_ERROR_PATTERN.test(message);
}

export function normalizeDesktopUpdateError(
  error: unknown,
  context: DesktopUpdateErrorContext,
): {
  message: string;
  rawMessage: string;
  toastAction: DesktopToastAction | null;
} {
  const rawMessage = formatDesktopUpdateRawError(error).trim();

  if (context === "download" && isChecksumErrorMessage(rawMessage)) {
    return {
      message: "The downloaded update could not be verified. Try downloading it again.",
      rawMessage,
      toastAction: RETRY_DOWNLOAD_TOAST_ACTION,
    };
  }

  if (isNetworkErrorMessage(rawMessage)) {
    if (context === "download") {
      return {
        message:
          "Couldn't download the update because the update server is unavailable. Try again in a moment.",
        rawMessage,
        toastAction: null,
      };
    }
    return {
      message: "Couldn't reach the update server. Check your connection and try again.",
      rawMessage,
      toastAction: null,
    };
  }

  return {
    message: rawMessage.length > 0 ? rawMessage : getFallbackDesktopUpdateErrorMessage(context),
    rawMessage,
    toastAction: null,
  };
}
