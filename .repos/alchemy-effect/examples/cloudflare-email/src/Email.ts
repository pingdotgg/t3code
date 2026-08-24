import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Cloudflare zone the example operates on. The same zone is used for
 * inbound (Email Routing) and outbound (`send_email` sender domain).
 */
export const ZONE = "alchemy-test-2.us";

/**
 * `from:` address the Worker is allowed to send mail as. Must live on a
 * sender domain with Email Routing enabled (the `Routing` resource below
 * takes care of that).
 */
export const SENDER = process.env.CLOUDFLARE_EMAIL_FROM ?? `bot@${ZONE}`;

/**
 * Destination the rules forward inbound mail to and that the Worker is
 * pinned to send to. Cloudflare requires this address to be verified
 * (recipient clicks a confirmation link) before any rule will deliver.
 */
export const DESTINATION = process.env.CLOUDFLARE_EMAIL_TO ?? "sam@alchemy.run";

/**
 * Enable Email Routing on the zone. This is the prerequisite for both
 * receiving mail (rules) and sending mail from a Worker (`send_email`
 * sender domain).
 */
export const Routing = Cloudflare.Email.Routing("Routing", {
  zone: ZONE,
});

/**
 * Register the destination address on the account. Cloudflare emails a
 * verification link the first time this address is added; until the
 * recipient clicks it, rules forwarding here will silently drop.
 */
export const Destination = Cloudflare.Email.Address("Destination", {
  email: DESTINATION,
});

/**
 * Forward inbound `inbox@<ZONE>` mail to the verified destination. The
 * matcher is a literal `to:` match; everything else falls through to
 * whatever catch-all rule (if any) is configured on the zone.
 */
export const InboxRule = Cloudflare.Email.Rule("InboxRule", {
  zone: ZONE,
  name: "Forward inbox to destination",
  matchers: [{ type: "literal", field: "to", value: `inbox@${ZONE}` }],
  actions: [{ type: "forward", value: [DESTINATION] }],
});

/**
 * `send_email` Worker binding restricted to the sender/destination pair
 * above so the Worker can't be tricked into emailing arbitrary recipients.
 */
export const SendEmail = Cloudflare.Email.SendEmail("Email", {
  allowedSenderAddresses: [SENDER],
  destinationAddress: DESTINATION,
});
