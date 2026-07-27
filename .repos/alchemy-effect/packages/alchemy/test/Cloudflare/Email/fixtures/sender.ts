import * as Cloudflare from "@/Cloudflare/index.ts";

const senderAddress = process.env.CLOUDFLARE_TEST_EMAIL_FROM;
const destinationAddress = process.env.CLOUDFLARE_TEST_EMAIL_TO;

/**
 * `send_email` binding for the deployed test Worker. Restricted to the
 * sender/destination pair supplied via env so the e2e test exercises a
 * real `.send()` round-trip against Cloudflare.
 */
export const Email = Cloudflare.Email.SendEmail("Email", {
  allowedSenderAddresses: senderAddress ? [senderAddress] : undefined,
  destinationAddress,
});
