import * as Effect from "effect/Effect";
import { ProviderModePolicy } from "../../ProviderMode.ts";

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
 * Under `alchemy dev` the binding is lowered onto the local email simulator:
 * `send()` validates the message and persists it as a `.eml` under
 * `.alchemy/local/email` instead of delivering mail. Pipe the descriptor
 * through `Alchemy.remote()` to send through the live Cloudflare Email
 * service in dev — the same opt-out aspect resources use.
 *
 *
 * ### Binding to a Worker
 * **Example:** Send to any verified destination
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
 * **Example:** Restrict the sender address
 * ```typescript
 * const Ops = Cloudflare.Email.SendEmail("OpsEmail", {
 *   allowedSenderAddresses: ["noreply@example.com"],
 *   destinationAddress: "ops@example.com",
 * });
 * ```
 *
 * ### Local development
 * **Example:** Send real mail from the dev loop
 * ```typescript
 * // Default: `send()` lands in the local simulator under `alchemy dev`.
 * // Alchemy.remote() opts into the live Email service instead:
 * const Email = Cloudflare.Email.SendEmail("Email", {
 *   allowedSenderAddresses: ["noreply@example.com"],
 * }).pipe(Alchemy.remote());
 * ```
 *
 * @resource
 */
export type SendEmail = SendEmailProps & {
  kind: SendEmailTypeId;
  name: string;
  /**
   * Alchemy-internal: opt-out of local emulation in `alchemy dev` — the
   * `Alchemy.remote()` decoration captured at registration time. Registered
   * on the host Worker via the binding-data `devRemote` channel, never on
   * the wire binding itself.
   */
  devRemote?: boolean;
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
  // Capture the `Alchemy.remote()` decoration the same way resources do —
  // at registration time, from the ambient ProviderModePolicy reference.
  // `send_email` has no cloud-side resource (and thus no provider mode to
  // stamp), so the captured flag rides on the descriptor instead.
  const devRemote = (yield* ProviderModePolicy) === true || undefined;
  return {
    kind: SendEmailTypeId,
    name: id,
    destinationAddress: props?.destinationAddress,
    allowedDestinationAddresses: props?.allowedDestinationAddresses,
    allowedSenderAddresses: props?.allowedSenderAddresses,
    devRemote,
  } satisfies SendEmail;
});
