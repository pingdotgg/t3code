import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  RepositoryEventSource,
  webhookPath,
  webhookSecretEnvName,
  type RepositoryEventSourceProps,
  type RepositoryEventSourceService,
  type WebhookEvent,
} from "./RepositoryEventSource.ts";
import { Webhook } from "./Webhook.ts";

/**
 * GitHub event source on any {@link WebhookHost}.
 *
 * Deploy-time: provisions a {@link Webhook} on the repository whose delivery
 * URL points at the host (at a deterministic per-repo path). The webhook
 * secret (the caller's `secret`, or a generated random one when omitted) is
 * bound onto the host via an `Output` accessor so the runtime can verify
 * delivery signatures.
 *
 * Runtime: claims requests on the repository's delivery path, verifies the
 * `HMAC-SHA256` signature against the bound secret, and forwards each
 * delivery to the subscriber. Requests on any other path fall through to the
 * host's own handler.
 *
 * Every Cloudflare Worker is a {@link WebhookHost}, so this is the only layer
 * to provide.
 *
 * @layer
 * @product Webhook
 * @provides GitHub.RepositoryEventSource
 */
export const RepositoryEventSourceLive = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const ctx = yield* WebhookHost;
    // Loosely-typed constructor — yielding the resource class erases its
    // `GitHub.Providers` requirement. The requirement is satisfied by the
    // stack at plan time.
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      props: RepositoryEventSourceProps,
      process: (event: WebhookEvent) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props);

      // Every delivery is verified: without a caller-supplied secret, mint a
      // stable random one shared by the webhook and the host.
      const webhookSecret =
        props.secret ??
        (yield* Namespace.push(
          ctx.LogicalId,
          Random(`${props.owner}/${props.repository}WebhookSecret`),
        )).text;

      // Deploy-time: provision the repository webhook pointing at the host.
      // Skipped once running inside the deployed host (the global guard).
      // Namespaced under the host so the webhook's logical identity matches the
      // previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          ctx.LogicalId,
          Effect.asVoid(
            createWebhook(`${props.owner}/${props.repository}`, {
              owner: props.owner,
              repository: props.repository,
              url: Output.interpolate`${ctx.url}${path}`,
              events: [...(props.events ?? ["push"])],
              secret: webhookSecret,
              contentType: "json",
            }),
          ),
        );
      }

      // Bind the webhook secret as an env accessor under a deterministic key.
      // This single `yield*` does both halves: at plan time it registers the
      // secret on the host, and it returns an Effect that reads the value
      // back at runtime, reconstructing the `Redacted` wrapper.
      const secret = yield* Output.named(
        Output.asOutput(webhookSecret),
        webhookSecretEnvName(props),
      );

      yield* ctx.route(path, (request) => handleDelivery(request, secret, process));
    }) as RepositoryEventSourceService;
  }),
);

const handleDelivery = <Req>(
  request: Request,
  // The bound secret accessor (see `Output.named` above).
  secret: Effect.Effect<Redacted.Redacted<string> | undefined>,
  process: (event: WebhookEvent<any>) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const body = yield* Effect.promise(() => request.text());

    const resolved = yield* secret;
    const signature = request.headers.get("x-hub-signature-256") ?? undefined;
    const valid = yield* verifySignature(
      resolved ? Redacted.value(resolved) : undefined,
      body,
      signature,
    );
    if (!valid) {
      return new Response("invalid signature", { status: 401 });
    }

    const name = request.headers.get("x-github-event") ?? "unknown";
    const id = request.headers.get("x-github-delivery") ?? "";

    const payload: unknown = yield* Effect.try(() => JSON.parse(body) as unknown).pipe(
      Effect.orElseSucceed(() => body),
    );

    // The wire shape matches `WebhookEvent`, but the runtime can't
    // statically prove `name`/`payload` line up with a specific member of
    // the discriminated union — GitHub's headers are the source of truth, so
    // cast across the boundary.
    const delivery = { id, name, payload } as unknown as WebhookEvent;

    yield* process(delivery).pipe(Effect.orDie);

    return new Response(null, { status: 202 });
  });

const verifySignature = (
  secret: string | undefined,
  body: string,
  signature: string | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!secret || !signature || !signature.startsWith("sha256=")) {
      return false;
    }
    const expected = yield* Effect.promise(async () => {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256=${hex}`;
    });
    return timingSafeEqual(expected, signature);
  });

/**
 * Constant-time string comparison. Avoids leaking signature bytes through
 * early-exit timing differences. `crypto.subtle.timingSafeEqual` isn't
 * available on Workers without `nodejs_compat`, so we roll a small one.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};
