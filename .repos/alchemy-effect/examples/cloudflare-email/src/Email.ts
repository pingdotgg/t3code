import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Cloudflare zone the example operates on. The same zone is used for
 * inbound (Email Routing) and outbound (`send_email` sender domain).
 */
export const ZONE = "alchemy-test-2.us";

/**
 * `from:` address the Worker is allowed to send mail as. Must live on a
 * sender domain with Email Routing enabled — the `Cloudflare.email(...)`
 * subscribe in `Api.ts` auto-creates the `EmailRouting` toggle for us.
 */
export const SENDER = process.env.CLOUDFLARE_EMAIL_FROM ?? `bot@${ZONE}`;

/**
 * Destination the Worker is pinned to send to. Cloudflare requires this
 * address to be verified (recipient clicks a confirmation link) before
 * `send_email` will deliver.
 */
export const DESTINATION =
  process.env.CLOUDFLARE_EMAIL_TO ?? "michael@alchemy.run";

/**
 * Inbox address the Worker subscribes to. Mail addressed here is routed
 * to the Worker's `email` handler via the `EmailRule` that the
 * `Cloudflare.email({ zone, matchers }).subscribe(...)` call auto-creates.
 */
export const INBOX = process.env.CLOUDFLARE_EMAIL_INBOX ?? `inbox@${ZONE}`;

/**
 * Register the destination address on the account. Cloudflare emails a
 * verification link the first time this address is added; until the
 * recipient clicks it, `send_email` calls targeting it will fail.
 */
export const Destination = Cloudflare.Email.Address("Destination", {
  email: DESTINATION,
});

/**
 * `send_email` Worker binding restricted to the sender/destination pair
 * above so the Worker can't be tricked into emailing arbitrary recipients.
 */
export const SendEmail = Cloudflare.Email.SendEmail("Email", {
  allowedSenderAddresses: [SENDER],
  destinationAddress: DESTINATION,
});
