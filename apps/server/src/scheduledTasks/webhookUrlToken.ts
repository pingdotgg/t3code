export const WITHHELD = "[withheld]";
const WEBHOOK_URL_TOKEN =
  /(\/(?:v1\/hooks\/[0-9a-f]{16}|api\/hooks)\/[^/\s"'\\]+\/)[A-Za-z0-9_-]+/g;

/**
 * Shows a webhook URL with its last segment withheld, as Settings is where the full URL lives.
 * Matches the URL as the server prints it, not an escaped or split one.
 */
export const withoutWebhookUrlToken = (text: string) =>
  text.replace(WEBHOOK_URL_TOKEN, `$1${WITHHELD}`);
