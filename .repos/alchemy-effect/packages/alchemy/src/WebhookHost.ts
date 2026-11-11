import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Output from "./Output.ts";

/**
 * A host that receives HTTP deliveries from an external service, such as
 * Stripe or GitHub webhooks. Event sources (`Stripe.ConsumeEventsLive`,
 * `GitHub.RepositoryEventSourceLive`) are written against it, so they don't
 * depend on the platform the host runs on.
 *
 * Hosts provide it themselves (see `RuntimeContext.hostServices`), so user
 * code only provides the event source. A secret bound with {@link
 * WebhookHostService.bind} is read back at runtime through `RuntimeContext`.
 *
 * TODO: only Cloudflare Workers provide it. Provide it from the other HTTP
 * hosts (Lambda, Fly, Railway, ...).
 */
export interface WebhookHostService {
  /** Logical ID of the host. Deploy-time resources are namespaced under it. */
  readonly LogicalId: string;
  /** The host's public base URL, without a trailing slash. */
  readonly url: Output.Output<string | undefined>;
  /**
   * Attach environment variables to the host as a binding under `id`. Unlike
   * a prop, a binding may depend on resources that depend on the host, such
   * as a webhook endpoint pointing at its `url`.
   */
  readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
  /**
   * Claim requests whose URL pathname is exactly `path` (no trailing-slash
   * normalization). One handler per path; claiming a path twice is a defect.
   * Requests on any other path fall through to the host's own handler.
   */
  readonly route: <Req>(
    path: string,
    handler: (request: Request) => Effect.Effect<Response, never, Req>,
  ) => Effect.Effect<void, never, Req>;
}

export class WebhookHost extends Context.Service<WebhookHost, WebhookHostService>()(
  "alchemy/WebhookHost",
) {}
