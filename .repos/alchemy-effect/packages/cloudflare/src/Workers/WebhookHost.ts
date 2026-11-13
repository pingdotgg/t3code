import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * {@link WebhookHost} for a Cloudflare Worker: the Worker's URL and a `fetch`
 * listener that claims one path. Every Worker provides it, so an event source
 * needs no host wiring:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // ...
 * }).pipe(Effect.provide(Stripe.ConsumeEventsLive));
 * ```
 *
 * @layer
 * @provides WebhookHost
 */
export const WebhookHostLive = Layer.effect(
  WebhookHost,
  Effect.gen(function* () {
    const host = yield* Worker;
    const claimed = new Set<string>();
    return WebhookHost.of({
      LogicalId: host.LogicalId,
      url: host.url,
      bind: (id, data) => host.bind(id, data),
      route: (path, handler) =>
        Effect.suspend(() => {
          if (claimed.has(path)) {
            return Effect.die(
              new Error(`Worker '${host.LogicalId}' already has a webhook handler on ${path}`),
            );
          }
          claimed.add(path);
          return host.listen((event) => {
            if (!isWorkerEvent(event) || event.type !== "fetch") return;
            const request = event.input as unknown as Request;
            let pathname: string;
            try {
              pathname = new URL(request.url).pathname;
            } catch {
              return;
            }
            if (pathname !== path) return;
            return handler(request);
          });
        }),
    });
  }),
);
