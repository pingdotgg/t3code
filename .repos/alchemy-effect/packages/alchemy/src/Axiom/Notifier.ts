import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type NotifierProps = Axiom.CreateNotifierInput;

export type Notifier = Resource<
  "Axiom.Notifier",
  NotifierProps,
  Axiom.CreateNotifierOutput & { id: string },
  never,
  Providers
>;

/**
 * An Axiom notifier — an alert destination (Slack, email, PagerDuty,
 * Opsgenie, Discord, Microsoft Teams, generic webhook, or a fully custom
 * webhook with templated body/headers) that {@link Monitor monitors} target
 * via `notifierIds`. Exactly one channel under `properties` should be set.
 *
 * @see https://axiom.co/docs/monitor-data/notifiers
 *
 * @section Creating a Notifier
 * @example Slack incoming webhook
 * ```typescript
 * const slack = yield* Axiom.Notifier("ops-slack", {
 *   name: "ops-channel",
 *   properties: {
 *     slack: { slackUrl: process.env.SLACK_WEBHOOK_URL! },
 *   },
 * });
 * ```
 *
 * @example Email distribution list
 * ```typescript
 * yield* Axiom.Notifier("ops-email", {
 *   name: "ops-team",
 *   properties: { email: { emails: ["sre@example.com", "oncall@example.com"] } },
 * });
 * ```
 *
 * @example PagerDuty integration
 * ```typescript
 * yield* Axiom.Notifier("pagerduty", {
 *   name: "primary-oncall",
 *   properties: {
 *     pagerduty: { routingKey: process.env.PAGERDUTY_ROUTING_KEY!, token: "" },
 *   },
 * });
 * ```
 *
 * @example Custom webhook with templated body
 * ```typescript
 * yield* Axiom.Notifier("incident-webhook", {
 *   name: "incident.io",
 *   properties: {
 *     customWebhook: {
 *       url: "https://api.incident.io/v2/alert_events",
 *       headers: { "Content-Type": "application/json" },
 *       secretHeaders: { Authorization: `Bearer ${process.env.INCIDENT_TOKEN}` },
 *       body: '{"title": "{{.Monitor.Name}}", "status": "firing"}',
 *     },
 *   },
 * });
 * ```
 */
export const Notifier = Resource<Notifier>("Axiom.Notifier");

export const NotifierProvider = () =>
  Provider.effect(
    Notifier,
    Effect.gen(function* () {
      const create = yield* Axiom.createNotifier;
      const update = yield* Axiom.updateNotifier;
      const get = yield* Axiom.getNotifier;
      const del = yield* Axiom.deleteNotifier;

      return {
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — Axiom assigns the notifier id server-side, so the
          // only handle to a previously-created notifier is the cached
          // `output.id`. Probe for live state with that id; treat NotFound
          // (deleted out-of-band) as "no observed state" so we converge
          // by re-creating.
          const observed = output?.id
            ? yield* get({ id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // Ensure — POST mints a new notifier. The Axiom create response
          // sometimes omits `id` on the body; default to "" to keep the
          // attribute shape stable until the next read populates it.
          if (observed === undefined) {
            const result = yield* create(news);
            return { ...result, id: result.id ?? "" };
          }

          // Sync — the notifier exists; PATCH against its id with the
          // desired props. Preserve the cached id if the API response
          // omits it.
          const result = yield* update({ ...news, id: observed.id! });
          return { ...result, id: result.id ?? observed.id! };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.map((current) => ({
              ...current,
              id: current.id ?? output.id,
            })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
