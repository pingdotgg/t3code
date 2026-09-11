/** Options for a `send_email` binding (local or remote). */
export interface SendEmailProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /** Restrict sends to exactly this recipient address. */
  readonly destinationAddress?: string;
  /** Restrict sends to this set of recipient addresses. */
  readonly allowedDestinationAddresses?: Array<string>;
  /** Restrict sends to this set of sender addresses. */
  readonly allowedSenderAddresses?: Array<string>;
}

/**
 * Service designator props passed to the send-email service entrypoint
 * (`ctx.props`). A single `send-email` service hosts every `send_email`
 * binding; each binding's designator carries its own address restrictions.
 */
export interface SendEmailServiceProps {
  readonly destinationAddress?: string;
  readonly allowedDestinationAddresses?: Array<string>;
  readonly allowedSenderAddresses?: Array<string>;
}

export const SERVICE_SEND_EMAIL = "send-email";
export const SERVICE_SEND_EMAIL_STORAGE = "send-email:storage";
export const SEND_EMAIL_ENTRYPOINT = "SendEmailBinding";

/** Disk service binding the send-email worker writes messages through. */
export const BINDING_SEND_EMAIL_DISK = "DISK";
/**
 * JSON binding carrying the node-side absolute path of the email persistence
 * directory (`{storage}/email`), so logged file paths point at real files.
 */
export const BINDING_SEND_EMAIL_DIRECTORY = "EMAIL_DIRECTORY";

/**
 * Key under which the local `EmailMessage` shim stores the raw MIME message.
 * Matches Miniflare's `RAW_EMAIL` constant (`workers/email/constants.ts`) —
 * a plain string (not a symbol) so it survives JSRPC structured clone.
 */
export const RAW_EMAIL = "EmailMessage::raw";
