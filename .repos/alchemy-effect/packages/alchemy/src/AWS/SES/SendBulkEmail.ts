import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";

/**
 * The `sendBulkEmail` request with the binding-injected members removed:
 * `ConfigurationSetName` comes from the bound configuration set, and
 * `FromEmailAddress` defaults to the bound identity (override it for domain
 * identities, e.g. `hello@{domain}`).
 */
export interface SendBulkEmailRequest extends Omit<
  sesv2.SendBulkEmailRequest,
  "ConfigurationSetName"
> {}

/**
 * Runtime binding for `sesv2:SendBulkEmail`.
 *
 * Bind this operation to an `EmailIdentity` (and optionally a
 * `ConfigurationSet`) inside a function runtime to get a callable that sends
 * one templated message to up to 50 destinations per call, with per-entry
 * replacement data. The binding grants the function the send actions scoped
 * to the identity, the account's templates, and the configuration set.
 *
 * Bulk sends always render a template — reference one via
 * `DefaultContent.Template`.
 * @binding
 * @section Sending Email
 * @example Send a Templated Message to Many Recipients
 * ```typescript
 * // init
 * const sendBulkEmail = yield* SES.SendBulkEmail(identity, configSet);
 *
 * // runtime
 * const result = yield* sendBulkEmail({
 *   DefaultContent: {
 *     Template: {
 *       TemplateName: "welcome-template",
 *       TemplateData: JSON.stringify({ name: "friend" }),
 *     },
 *   },
 *   BulkEmailEntries: [
 *     {
 *       Destination: { ToAddresses: ["ada@example.com"] },
 *       ReplacementEmailContent: {
 *         ReplacementTemplate: {
 *           ReplacementTemplateData: JSON.stringify({ name: "Ada" }),
 *         },
 *       },
 *     },
 *   ],
 * });
 * // result.BulkEmailEntryResults
 * ```
 */
export interface SendBulkEmail extends Binding.Service<
  SendBulkEmail,
  "AWS.SES.SendBulkEmail",
  <I extends EmailIdentity>(
    identity: I,
    configurationSet?: ConfigurationSet,
  ) => Effect.Effect<
    (
      request: SendBulkEmailRequest,
    ) => Effect.Effect<sesv2.SendBulkEmailResponse, sesv2.SendBulkEmailError>
  >
> {}
export const SendBulkEmail = Binding.Service<SendBulkEmail>(
  "AWS.SES.SendBulkEmail",
);
