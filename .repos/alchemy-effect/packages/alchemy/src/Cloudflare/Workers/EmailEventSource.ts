import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as RemovalPolicy from "../../RemovalPolicy.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { CatchAll } from "../Email/CatchAll.ts";
import { Routing } from "../Email/Routing.ts";
import { Rule, type Matcher } from "../Email/Rule.ts";
import type { Reference } from "../Zone/lookup.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * Effect-native wrapper around Cloudflare's
 * [`ForwardableEmailMessage`](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/#forwardableemailmessage).
 *
 * Follows the same shape as the other Cloudflare bindings (R2, KV, …):
 *
 * - `raw` is the underlying `cf.ForwardableEmailMessage` — an escape
 *   hatch for any field or future API not yet wrapped.
 * - Ergonomic fields (`from`, `to`, `headers`, `body`, `bodySize`) are
 *   forwarded verbatim.
 * - Action methods (`forward`, `reply`, `setReject`) return `Effect`s
 *   instead of `Promise`/`void`.
 */
export interface ForwardableEmailMessage {
  /** Underlying Cloudflare message — escape hatch for unwrapped APIs. */
  readonly raw: cf.ForwardableEmailMessage;
  /** Envelope From address. */
  readonly from: string;
  /** Envelope To address. */
  readonly to: string;
  /** RFC 5322 headers. */
  readonly headers: cf.Headers;
  /** Raw message body stream (RFC 5322 wire bytes). */
  readonly body: cf.ReadableStream<Uint8Array>;
  /** Size of the raw message body in bytes. */
  readonly bodySize: number;
  /**
   * Reject this message back to the connecting client with a permanent
   * SMTP error and the given reason.
   */
  setReject(reason: string): Effect.Effect<void>;
  /**
   * Forward this message to a verified destination address on the
   * account. Fails with `EmailError` if Cloudflare rejects the forward
   * (e.g. unverified destination).
   */
  forward(
    rcptTo: string,
    headers?: cf.Headers,
  ): Effect.Effect<void, EmailError>;
  /**
   * Reply to the sender with a new outbound message. Fails with
   * `EmailError` if Cloudflare rejects the reply.
   */
  reply(message: cf.EmailMessage): Effect.Effect<void, EmailError>;
}

export class EmailError extends Data.TaggedError("EmailError")<{
  action: "forward" | "reply";
  message: string;
  cause: unknown;
}> {}

const wrap = (raw: cf.ForwardableEmailMessage): ForwardableEmailMessage => ({
  raw,
  from: raw.from,
  to: raw.to,
  headers: raw.headers,
  body: raw.raw,
  bodySize: raw.rawSize,
  setReject: (reason) => Effect.sync(() => raw.setReject(reason)),
  forward: (rcptTo, headers) =>
    Effect.tryPromise({
      try: () => raw.forward(rcptTo, headers),
      catch: (cause) =>
        new EmailError({
          action: "forward",
          message: `Cloudflare email forward failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
  reply: (msg) =>
    Effect.tryPromise({
      try: () => raw.reply(msg),
      catch: (cause) =>
        new EmailError({
          action: "reply",
          message: `Cloudflare email reply failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
});

/**
 * Whether a subscription's matchers describe the zone's catch-all — either
 * omitted entirely (the documented default) or a lone `{ type: "all" }`.
 * Cloudflare models that as a per-zone singleton behind `/rules/catch_all`,
 * so it maps to `Email.CatchAll` rather than `Email.Rule`.
 */
const isCatchAll = (matchers: Matcher[] | undefined): boolean =>
  matchers === undefined ||
  (matchers.length === 1 && matchers[0]?.type === "all");

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Settings for {@link email} — both halves of the consumer in one place.
 * `zone` opts in to the deploy-time setup: an `Email.Routing` toggle on the
 * zone plus the routing resource that hands matched mail to the host
 * Worker. Omit `zone` to manage routing yourself.
 *
 * Which routing resource depends on {@link EmailSubscribeProps.matchers}:
 * a catch-all subscription yields `Email.CatchAll` (Cloudflare models the
 * zone catch-all as a singleton behind its own endpoint), anything more
 * specific yields `Email.Rule`.
 */
export interface EmailSubscribeProps {
  /**
   * Zone to enable email routing on and attach the routing resource to.
   * Accepts a zone id, a zone name (`example.com`), or a
   * `{ zoneId, name? }` object (a `Cloudflare.Zone` resource works).
   * Required to auto-create routing resources; omit if you're managing
   * `Email.Routing` and `Email.Rule`/`Email.CatchAll` yourself.
   */
  zone?: Input<Reference>;
  /**
   * Which envelopes Cloudflare delivers to this Worker. Ignored when
   * `zone` is omitted.
   *
   * Omitting this (or passing a lone `{ type: "all" }`) subscribes to the
   * zone's catch-all, provisioned as `Email.CatchAll`. There is exactly one
   * catch-all per zone, so a second Worker subscribing to it takes the
   * zone's mail from the first.
   *
   * @default [{ type: "all" }]
   */
  matchers?: Matcher[];
  /**
   * Display name for the auto-created `Email.Rule` / `Email.CatchAll`.
   *
   * @default the host worker's logical id
   */
  ruleName?: string;
  /**
   * Priority of the auto-created `Email.Rule`. Lower numbers run first.
   * Ignored for a catch-all subscription — the catch-all is always
   * evaluated last.
   *
   * @default 0
   */
  priority?: number;
  /**
   * Whether the auto-created `Email.Rule` / `Email.CatchAll` is enabled.
   *
   * @default true
   */
  enabled?: boolean;
}

/**
 * Subscribe to Cloudflare Email Worker events with an Effect handler.
 *
 * Wires both halves of the consumer in one call:
 *
 * - **Runtime**: registers an `email` event listener on the Worker.
 *   The handler receives a {@link ForwardableEmailMessage} whose
 *   action methods (`forward`, `reply`, `setReject`) return `Effect`s.
 * - **Deploy-time** (when `zone` is set): yields a
 *   `Cloudflare.Email.Routing` toggle on the zone plus the routing
 *   resource whose `actions: [{ type: "worker", … }]` targets this
 *   Worker — `Cloudflare.Email.CatchAll` for a catch-all subscription,
 *   `Cloudflare.Email.Rule` for anything more specific. No manual
 *   wiring needed in `alchemy.run.ts`.
 *
 * Requires `EmailEventSourceLive` provided on the Worker's Effect.
 *
 * **Failure semantics**: a failing handler is logged and the failure is
 * re-raised. Cloudflare turns that into a temporary SMTP failure, so the
 * sending server keeps the message and retries later — mail is never
 * accepted and then silently dropped. Handle the failures you consider
 * final inside the handler (`Effect.retry`, `Effect.catchTag`, or
 * `message.setReject(...)` to bounce permanently); anything you let
 * escape becomes a retryable delivery failure.
 *
 * ### Subscribing to Inbound Mail
 * **Example:** Catch-all on a zone — auto-creates routing + catch-all
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * export default Cloudflare.Worker(
 *   "Inbox",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.email({ zone: "example.com" }).subscribe(
 *       (message) => message.forward("ops@example.com"),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
 * );
 * ```
 *
 * **Example:** Match a specific address
 * ```typescript
 * yield* Cloudflare.email({
 *   zone: "example.com",
 *   matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
 * }).subscribe((message) => message.forward("ops@example.com"));
 * ```
 *
 * **Example:** Reject (bounce) a message
 * ```typescript
 * yield* Cloudflare.email({ zone: "example.com" }).subscribe((message) =>
 *   message.setReject("Mailbox closed"),
 * );
 * ```
 *
 * **Example:** Bring-your-own routing — no `zone`, no auto-create
 * ```typescript
 * // Manage `Email.Routing` / `Email.Rule` yourself in alchemy.run.ts.
 * yield* Cloudflare.email().subscribe((message) =>
 *   Effect.log(`from ${message.from}`),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/email-routing/email-workers/
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const email = (props: EmailSubscribeProps = {}) => ({
  subscribe: <E = never, Req = never>(
    process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
  ) => EmailEventSource.use((source) => source(props, process)),
});

export type EmailEventSourceService = <E = never, Req = never>(
  props: EmailSubscribeProps,
  process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
) => Effect.Effect<void, never, never>;

export class EmailEventSource extends Context.Service<
  EmailEventSource,
  EmailEventSourceService
>()("Cloudflare.Workers.EmailEventSource") {}

export const EmailEventSourceLive = Layer.effect(
  EmailEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <E, Req>(
      props: EmailSubscribeProps,
      process: (
        message: ForwardableEmailMessage,
      ) => Effect.Effect<void, E, Req>,
    ) {
      // Deploy-time: provision the Email.Routing toggle plus the routing
      // resource that hands matched mail to this Worker. Skipped once
      // running inside the deployed Worker (the global guard) and when
      // `zone` is omitted (bring-your-own routing). Namespaced under the
      // host so logical identity is stable per Worker.
      if (!globalThis.__ALCHEMY_RUNTIME__ && props.zone !== undefined) {
        const zone = props.zone;
        const matchers = props.matchers;
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Routing is a per-zone singleton shared with other rules on
            // the zone, so destroying this Worker must not disable it.
            yield* Routing("EmailRouting", {
              zone,
              enabled: true,
            }).pipe(RemovalPolicy.retain());

            const action = {
              type: "worker" as const,
              value: [host.workerName],
            };

            // Catch-all is a per-zone SINGLETON living behind
            // `/rules/catch_all`, not an ordinary rule. Cloudflare surfaces
            // it in `listRules` but rejects mutating it through the rule
            // endpoint ("Invalid rule operation"), so creating it as an
            // `Email.Rule` would produce a row the engine cannot delete.
            // Route an all-matcher subscription to `Email.CatchAll`
            // instead — the resource that owns that endpoint.
            if (isCatchAll(matchers)) {
              yield* CatchAll("EmailCatchAll", {
                zone,
                name: props.ruleName ?? host.LogicalId,
                enabled: props.enabled ?? true,
                actions: [action],
              });
              return;
            }

            yield* Rule("EmailRule", {
              zone,
              name: props.ruleName ?? host.LogicalId,
              enabled: props.enabled ?? true,
              priority: props.priority ?? 0,
              matchers: matchers!,
              actions: [action],
            });
          }),
        );
      }

      // Resolve the runtime context per-call rather than at layer
      // construction (mirrors `Queues.EventSourceLive`).
      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "email") return;

        const message = wrap(event.input as cf.ForwardableEmailMessage);
        // Log, then let the failure propagate. Cloudflare turns an
        // exception out of the `email` handler into a temporary SMTP
        // failure, so the sending server keeps the message and retries.
        // Swallowing it here would instead ACCEPT the envelope and then
        // drop it: a transient dependency outage would silently destroy
        // mail with nothing left to retry from.
        return process(message).pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              console.error(
                `[EmailEventSource] handler failed for message to ` +
                  `"${message.to}": ${Cause.pretty(cause)}`,
              );
            }),
          ),
          // The listener contract is `E = never`, so surface the failure as
          // a defect rather than discarding it: the invocation fails, which
          // is what Cloudflare turns into the temporary SMTP failure.
          Effect.orDie,
        );
      });
    }) as EmailEventSourceService;
  }),
);
