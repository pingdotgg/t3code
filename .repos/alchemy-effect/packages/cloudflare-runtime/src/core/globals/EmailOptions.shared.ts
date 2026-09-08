/**
 * Reserved entry-socket path that dispatches an inbound email to the user
 * worker's `email()` handler, mirroring Miniflare's `CorePaths.EMAIL`
 * (`workers-sdk/packages/miniflare/src/workers/core/constants.ts`).
 *
 * Required query parameters (matching Miniflare's `workers/core/email.ts`):
 * - `from` — the SMTP envelope MAIL FROM address
 * - `to` — the SMTP envelope RCPT TO address
 *
 * The request body carries the raw MIME message.
 */
export const PATH_EMAIL = "/cdn-cgi/handler/email";

/**
 * Prefix shared by all trigger-handler paths (`CorePaths.HANDLER_PREFIX`).
 * Unknown paths under it get a 404 pointing at the valid handlers.
 */
export const PATH_HANDLER_PREFIX = "/cdn-cgi/handler/";

/**
 * Disk service rooted at `{storage}/email` — the same directory the
 * send-email simulator persists to — that the entry worker writes email
 * replies through (Miniflare stores replies via its loopback
 * `store-temp-file` endpoint instead).
 */
export const SERVICE_EMAIL_STORAGE = "email:storage";

/** Disk service binding the entry worker writes email replies through. */
export const BINDING_EMAIL_DISK = "EMAIL_DISK";

/**
 * JSON binding carrying the node-side absolute path of the email persistence
 * directory (`{storage}/email`), so logged file paths point at real files.
 */
export const BINDING_EMAIL_DIRECTORY = "EMAIL_DIRECTORY";
