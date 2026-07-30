import * as Effect from "effect/Effect";

type SendEmailTypeId = typeof SendEmailTypeId;
const SendEmailTypeId = "Cloudflare.Email.SendEmail" as const;

export type SendEmailProps = {
  /**
   * Restrict the Worker to send to a single verified destination address.
   *
   * Mutually exclusive with `allowedDestinationAddresses`. The destination
   * must be a verified address on the account (see {@link Address}).
   */
  destinationAddress?: string;
  /**
   * Restrict the Worker to send to one of these verified destination addresses.
   *
   * Mutually exclusive with `destinationAddress`.
   */
  allowedDestinationAddresses?: string[];
  /**
   * Restrict the Worker to send from one of these sender addresses.
   *
   * The sender domain must have Email Routing configured (see
   * {@link Routing}) and the addresses must be verified.
   */
  allowedSenderAddresses?: string[];
};

/**
 * A Cloudflare Workers `send_email` binding descriptor.
 *
 * `SendEmail` is a Worker-only binding — it does not create any cloud-side
 * resource. The descriptor names the binding and records optional
 * destination/sender restrictions; the actual `send_email` entry is attached
 * to the Worker via {@link SendBinding}.
 *
 * @resource
 *
 * @section Binding to a Worker
 * @example Send to any verified destination
 * ```typescript
 * const Email = Cloudflare.Email.SendEmail("Email");
 *
 * // in the Worker effect:
 * const email = yield* Cloudflare.Email.Send(Email);
 * yield* email.send({
 *   from: "noreply@example.com",
 *   to: "user@example.com",
 *   subject: "Hello",
 *   text: "Hi from Alchemy",
 * });
 * ```
 *
 * @example Restrict the sender address
 * ```typescript
 * const Ops = Cloudflare.Email.SendEmail("OpsEmail", {
 *   allowedSenderAddresses: ["noreply@example.com"],
 *   destinationAddress: "ops@example.com",
 * });
 * ```
 */
export type SendEmail = SendEmailProps & {
  kind: SendEmailTypeId;
  name: string;
};

export const isSendEmail = (value: unknown): value is SendEmail =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as SendEmail).kind === SendEmailTypeId;

export const SendEmail: (
  id: string,
  props?: SendEmailProps,
) => Effect.Effect<SendEmail> = Effect.fn(function* (
  id: string,
  props?: SendEmailProps,
) {
  return {
    kind: SendEmailTypeId,
    name: id,
    destinationAddress: props?.destinationAddress,
    allowedDestinationAddresses: props?.allowedDestinationAddresses,
    allowedSenderAddresses: props?.allowedSenderAddresses,
  } satisfies SendEmail;
});
