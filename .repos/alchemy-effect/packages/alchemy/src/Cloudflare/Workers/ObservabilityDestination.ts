import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.ObservabilityDestination" as const;
type TypeId = typeof TypeId;

/**
 * The Workers Logs dataset exported by an observability destination.
 */
export type ObservabilityDataset =
  | "opentelemetry-traces"
  | "opentelemetry-logs"
  | "opentelemetry-metrics";

export interface ObservabilityDestinationProps {
  /**
   * Human readable destination name. Cloudflare derives the destination's
   * stable `slug` from it and the name cannot be changed afterwards —
   * updating this property triggers a replacement. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * HTTPS endpoint the OTLP payloads are pushed to (e.g. an OTLP/HTTP
   * collector). Mutable — updated in place.
   *
   * Cloudflare verifies the endpoint with a preflight request on create
   * (unless {@link skipPreflightCheck} is set) and on **every** update, so
   * the endpoint must accept a `POST` with a `2xx` response for updates to
   * succeed.
   */
  url: string;
  /**
   * Extra HTTP headers sent with each push (e.g. authentication tokens).
   * Cloudflare always adds a `content-type: application/json` header of
   * its own. Mutable — updated in place.
   * @default {}
   */
  headers?: Record<string, string>;
  /**
   * Which Workers Logs dataset to export. Cannot be changed after
   * creation — updating this property triggers a replacement.
   */
  logpushDataset: ObservabilityDataset;
  /**
   * Whether the destination actively exports data. Mutable — updated in
   * place.
   * @default true
   */
  enabled?: boolean;
  /**
   * Skip the create-time preflight request against {@link url}. Useful
   * when the collector rejects empty probe payloads. Create-only — the
   * update API always performs the preflight check.
   * @default false
   */
  skipPreflightCheck?: boolean;
}

export interface ObservabilityDestinationAttributes {
  /**
   * Cloudflare-assigned stable identifier, derived from the name at
   * creation time.
   */
  slug: string;
  /**
   * The Cloudflare account the destination belongs to.
   */
  accountId: string;
  /**
   * Human readable destination name.
   */
  name: string;
  /**
   * Whether the destination actively exports data.
   */
  enabled: boolean;
  /**
   * HTTPS endpoint the OTLP payloads are pushed to.
   */
  url: string;
  /**
   * The Workers Logs dataset this destination exports.
   */
  logpushDataset: ObservabilityDataset;
  /**
   * The underlying Logpush destination string (the URL with the
   * configured headers encoded as query parameters).
   */
  destinationConf: string;
  /**
   * Names of the Worker scripts currently opted in to this destination.
   */
  scripts: string[];
}

export type ObservabilityDestination = Resource<
  TypeId,
  ObservabilityDestinationProps,
  ObservabilityDestinationAttributes,
  never,
  Providers
>;

/**
 * A Workers observability destination — an account-level OTLP export of
 * Workers Logs telemetry (traces, logs, or metrics) pushed to an external
 * HTTPS collector via Logpush.
 *
 * A destination is identified by its Cloudflare-derived `slug` (stable,
 * computed from the name at creation). The endpoint URL, headers, and
 * enabled flag are mutable in place; `name` and `logpushDataset` force a
 * replacement.
 *
 * Cloudflare preflights the endpoint with a `POST` on create (skippable
 * via `skipPreflightCheck`) and on every in-place update (not skippable),
 * so the collector must answer `2xx` for updates to converge.
 *
 * Safety: destinations carry no ownership markers and Cloudflare enforces
 * one destination per name. When there is no prior state, `read` scans the
 * account for a destination with the same name and reports it as
 * `Unowned`, so the engine refuses to take it over unless `--adopt` (or
 * `adopt(true)`) is set.
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Exporting Workers traces
 * @example Push traces to an OTLP collector
 * ```typescript
 * const traces = yield* Cloudflare.Workers.ObservabilityDestination("Traces", {
 *   url: "https://otel.example.com/v1/traces",
 *   headers: { authorization: secret },
 *   logpushDataset: "opentelemetry-traces",
 * });
 * ```
 *
 * @section Exporting Workers logs
 * @example Push logs, skipping the create-time preflight
 * ```typescript
 * const logs = yield* Cloudflare.Workers.ObservabilityDestination("Logs", {
 *   name: "my-app-logs",
 *   url: "https://collector.example.com/v1/logs",
 *   logpushDataset: "opentelemetry-logs",
 *   skipPreflightCheck: true,
 * });
 * ```
 *
 * @section Pausing an export
 * @example Disable the destination without deleting it
 * ```typescript
 * yield* Cloudflare.Workers.ObservabilityDestination("Logs", {
 *   name: "my-app-logs",
 *   url: "https://collector.example.com/v1/logs",
 *   logpushDataset: "opentelemetry-logs",
 *   enabled: false,
 * });
 * ```
 */
export const ObservabilityDestination =
  Resource<ObservabilityDestination>(TypeId);

/**
 * Returns true if the given value is an ObservabilityDestination resource.
 */
export const isObservabilityDestination = (
  value: unknown,
): value is ObservabilityDestination =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ObservabilityDestinationProvider = () =>
  Provider.succeed(ObservabilityDestination, {
    stables: ["slug", "accountId", "name", "logpushDataset"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The slug is derived from the name at creation and the update API
      // cannot rename — a name change is a replacement.
      const oldName =
        output?.name ?? olds?.name ?? (yield* createDestinationName(id));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const newName = news.name ?? oldName;
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
      // The update API cannot change the dataset.
      const oldDataset = output?.logpushDataset ?? olds?.logpushDataset;
      if (oldDataset !== undefined && oldDataset !== news.logpushDataset) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted slug.
      if (output?.slug) {
        const observed = yield* findBySlug(acct, output.slug);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Adoption path: no state of our own, but Cloudflare enforces one
      // destination per name, so an exact name match is the same logical
      // destination. Destinations carry no ownership markers, so brand it
      // `Unowned` and let the engine gate takeover behind the adopt
      // policy.
      const name = olds?.name ?? (yield* createDestinationName(id));
      const observed = yield* findByName(acct, name);
      return observed ? Unowned(toAttributes(observed, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts.
      const name =
        news.name ?? output?.name ?? (yield* createDestinationName(id));
      // Inputs have been resolved to concrete strings by Plan.
      const url = news.url as string;
      const headers = (news.headers ?? {}) as Record<string, string>;
      const enabled = news.enabled ?? true;

      // 1. Observe — the slug cached on `output` is a hint, not a
      //    guarantee; fall back to the name (Cloudflare enforces name
      //    uniqueness, and ownership of a name match has already been
      //    verified upstream by `read` + the adopt policy).
      let observed = output?.slug
        ? yield* findBySlug(accountId, output.slug)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure. The API reports both a duplicate name and a failed
      //    endpoint preflight as the same opaque 400 — re-observe by name
      //    to tell a creation race (converge via sync below) from a
      //    genuine failure (re-fail).
      if (!observed) {
        const created = yield* workers
          .createObservabilityDestination({
            accountId,
            name,
            enabled,
            skipPreflightCheck: news.skipPreflightCheck,
            configuration: {
              type: "logpush",
              url,
              headers,
              logpushDataset: news.logpushDataset,
            },
          })
          .pipe(
            Effect.catchTag(
              "ObservabilityDestinationCreateFailed",
              (originalError) =>
                Effect.gen(function* () {
                  const match = yield* findByName(accountId, name);
                  if (!match) {
                    return yield* Effect.fail(originalError);
                  }
                  return match;
                }),
            ),
          );
        observed = isObservedDestination(created)
          ? created
          : yield* freshObserved(accountId, created.slug);
      }

      // 3. Sync — diff observed cloud state against desired and PATCH only
      //    on drift. Skipping the no-op matters doubly here: every PATCH
      //    re-runs the endpoint preflight.
      if (
        observed.enabled !== enabled ||
        observed.configuration.url !== url ||
        !sameHeaders(observed.configuration.headers, headers)
      ) {
        const patched = yield* workers
          .patchObservabilityDestination({
            accountId,
            slug: observed.slug,
            enabled,
            configuration: { type: "logpush", url, headers },
          })
          .pipe(
            // Every PATCH re-runs the endpoint preflight POST from
            // Cloudflare's edge. A freshly deployed endpoint (e.g. a
            // workers.dev sink) can transiently fail that probe while the
            // route propagates, so ride out preflight failures briefly.
            Effect.retry({
              while: (e) =>
                e._tag === "ObservabilityDestinationPreflightFailed",
              schedule: Schedule.min([
                Schedule.exponential("1 second"),
                Schedule.spaced("5 seconds"),
              ]),
              times: 8,
            }),
          );
        observed = yield* freshObserved(accountId, patched.slug);
      }

      // 4. Return.
      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* workers
        .deleteObservabilityDestination({
          accountId: output.accountId,
          slug: output.slug,
        })
        .pipe(
          Effect.catchTag(
            "ObservabilityDestinationNotFound",
            () => Effect.void,
          ),
        );
    }),

    // Account collection. Observability destinations are account-scoped and
    // the distilled list op paginates on `result`; exhaustively collect every
    // page and hydrate each item into the exact `read` Attributes shape via
    // `toAttributes`. The destination's stored credentials/headers token are
    // write-only on the API, so — like `read` — they never appear here.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* workers.listObservabilityDestinations
        .items({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).map((observed) =>
              toAttributes(observed, accountId),
            ),
          ),
        );
    }),
  });

type ObservedDestination =
  workers.ListObservabilityDestinationsResponse["result"][number];

const isObservedDestination = (
  value: ObservedDestination | workers.CreateObservabilityDestinationResponse,
): value is ObservedDestination =>
  Predicate.hasProperty(value.configuration, "headers");

const createDestinationName = (id: string) =>
  createPhysicalName({ id, lowercase: true });

/**
 * Locate a destination by its stable slug. There is no get-by-slug API,
 * so observation goes through the list endpoint.
 */
const findBySlug = (accountId: string, slug: string) =>
  workers.listObservabilityDestinations.items({ accountId }).pipe(
    Stream.filter((d) => d.slug === slug),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).at(0)),
  );

/**
 * Locate a destination by exact name. Cloudflare enforces name
 * uniqueness, so a match identifies the destination.
 */
const findByName = (accountId: string, name: string) =>
  workers.listObservabilityDestinations.items({ accountId }).pipe(
    Stream.filter((d) => d.name === name),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).at(0)),
  );

/**
 * Re-read a destination through the list endpoint after a write. The
 * create/patch responses omit the stored headers, so the list item is the
 * canonical observed shape.
 */
const freshObserved = (accountId: string, slug: string) =>
  findBySlug(accountId, slug).pipe(
    Effect.flatMap((observed) =>
      observed
        ? Effect.succeed(observed)
        : // The destination cannot vanish between the write that just
          // succeeded and this read except via an out-of-band delete racing
          // us — surface that as the typed not-found the API would raise.
          Effect.fail(
            new workers.ObservabilityDestinationNotFound({
              code: 0,
              message: `observability destination "${slug}" disappeared during reconcile`,
            }),
          ),
    ),
  );

/**
 * Compare observed headers against the desired set. Cloudflare always
 * injects a `content-type: application/json` header of its own — ignore
 * it unless the user explicitly pinned one, so an empty desired set is
 * not perpetually "dirty".
 */
const sameHeaders = (
  observed: Record<string, unknown>,
  desired: Record<string, string>,
) => {
  const normalized = Object.fromEntries(
    Object.entries(observed)
      .filter(([key]) => key !== "content-type" || "content-type" in desired)
      .map(([key, value]) => [key, String(value)]),
  );
  const keys = Object.keys(normalized);
  return (
    keys.length === Object.keys(desired).length &&
    keys.every((key) => normalized[key] === desired[key])
  );
};

const toAttributes = (
  observed: ObservedDestination,
  accountId: string,
): ObservabilityDestinationAttributes => ({
  slug: observed.slug,
  accountId,
  name: observed.name,
  enabled: observed.enabled,
  url: observed.configuration.url,
  // Distilled widens generated string enums to open unions (`string & {}`).
  logpushDataset: observed.configuration.logpushDataset as ObservabilityDataset,
  destinationConf: observed.configuration.destinationConf,
  scripts: [...observed.scripts],
});
