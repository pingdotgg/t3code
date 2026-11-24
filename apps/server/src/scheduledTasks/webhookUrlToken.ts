export const WITHHELD = "[withheld]";
const WEBHOOK_URL_TOKEN =
  /(\/v1\/hooks\/[0-9a-f]{16}\/[^/\s"'\\]+\/)[A-Za-z0-9_-]+|(\/api\/hooks\/[^/\s"'\\]+\/)[A-Za-z0-9_-]{32,}/g;

/**
 * Shows a webhook URL with its last segment withheld, as Settings is where the full URL lives.
 * Matches the URL as the server prints it, not an escaped or split one. A direct URL's token is
 * never shorter than 32 characters, so a project path such as app/api/hooks/stripe/route.ts keeps
 * its file name.
 */
export const withoutWebhookUrlToken = (text: string) =>
  text.replace(WEBHOOK_URL_TOKEN, `$1$2${WITHHELD}`);
