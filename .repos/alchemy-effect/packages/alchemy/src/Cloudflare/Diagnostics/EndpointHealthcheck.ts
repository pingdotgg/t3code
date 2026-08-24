import * as diagnostics from "@distilled.cloud/cloudflare/diagnostics";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Diagnostics.EndpointHealthcheck" as const;
type TypeId = typeof TypeId;

export interface EndpointHealthcheckProps {
  /**
   * The IP address of the host to perform checks against. Must be an
   * on-net (private) IP reachable through Magic Transit / Magic WAN, and
   * unique among the account's endpoint healthchecks — Cloudflare rejects
   * public or duplicate IPs with an "Invalid request" error (code 1002,
   * surfaced as the typed `InvalidHealthcheckEndpoint`).
   */
  endpoint: string;
  /**
   * Type of check to perform. Only `"icmp"` is supported today.
   * @default "icmp"
   */
  checkType?: "icmp";
  /**
   * Optional name associated with this check. Not unique on Cloudflare's
   * side. If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   *
   * Cannot be changed after creation — Cloudflare's PUT endpoint echoes a
   * new name back but never persists it — so updating this property
   * triggers a replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
}

export interface EndpointHealthcheckAttributes {
  /** UUID of the endpoint healthcheck. Stable across updates. */
  healthcheckId: string;
  /** The Cloudflare account the healthcheck belongs to. */
  accountId: string;
  /** Type of check performed. */
  checkType: "icmp";
  /** The IP address of the host checks are performed against. */
  endpoint: string;
  /** Name associated with this check. */
  name: string;
}

export type EndpointHealthcheck = Resource<
  TypeId,
  EndpointHealthcheckProps,
  EndpointHealthcheckAttributes,
  never,
  Providers
>;

/**
 * A Magic Transit / Magic WAN endpoint healthcheck — a continuous ICMP
 * probe of an on-net IP address used to monitor reachability of hosts
 * behind Magic tunnels.
 *
 * The `endpoint` must be a private (on-net) IP; Cloudflare rejects public
 * IPs with the typed `InvalidHealthcheckEndpoint` error. The `endpoint` is
 * mutable in place via PUT (the UUID is stable across updates), but `name`
 * is create-only — changing it triggers a replacement.
 * @resource
 * @product Diagnostics
 * @category Observability & Analytics
 * @section Creating an endpoint healthcheck
 * @example Probe an on-net host
 * ```typescript
 * const check = yield* Cloudflare.Diagnostics.EndpointHealthcheck("core-router", {
 *   endpoint: "10.0.0.1",
 * });
 * ```
 *
 * @example With an explicit name
 * ```typescript
 * const check = yield* Cloudflare.Diagnostics.EndpointHealthcheck("core-router", {
 *   endpoint: "10.0.0.1",
 *   name: "core-router-probe",
 * });
 * ```
 *
 * @section Updating
 * @example Re-point the probe at a different host
 * ```typescript
 * // Changing `endpoint` updates the same healthcheck in place.
 * const check = yield* Cloudflare.Diagnostics.EndpointHealthcheck("core-router", {
 *   endpoint: "10.0.0.2",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/
 */
export const EndpointHealthcheck = Resource<EndpointHealthcheck>(TypeId);

/**
 * Returns true if the given value is an EndpointHealthcheck resource.
 */
export const isEndpointHealthcheck = (
  value: unknown,
): value is EndpointHealthcheck =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const EndpointHealthcheckProvider = () =>
  Provider.succeed(EndpointHealthcheck, {
    stables: ["healthcheckId", "accountId"],

    diff: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // Healthchecks live under an account; moving accounts is a replace.
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // The name is create-only: Cloudflare's PUT echoes a new name back
      // but never persists it, so a name change forces a replacement.
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const desiredName =
        news.name ??
        output?.name ??
        (yield* createHealthcheckName(id, news.name));
      if (output !== undefined && output.name !== desiredName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.healthcheckId) {
        const observed = yield* getHealthcheck(acct, output.healthcheckId);
        if (observed) return toAttributes(observed, acct);
        return undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Healthchecks carry no ownership markers, so report
      // the match as Unowned and let the adopt policy gate takeover.
      const name = yield* createHealthcheckName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createHealthcheckName(id, news.name);
      const desired = {
        checkType: news.checkType ?? ("icmp" as const),
        endpoint: news.endpoint,
        name,
      };

      // Observe — the id cached on `output` is a hint, not a guarantee:
      // a "No entry found" falls through to missing and we recreate.
      // A GET right after a prior create can transiently 404 while the
      // new healthcheck propagates; bounded-retry on the typed
      // `EndpointHealthcheckNotFound` before concluding it is gone, so a
      // propagation blip never leaks a duplicate (names are not unique).
      const observed = output?.healthcheckId
        ? yield* observeExisting(
            output.accountId ?? accountId,
            output.healthcheckId,
          )
        : undefined;

      // Ensure — greenfield (or out-of-band delete): create with the full
      // desired body. Names are not unique so there is no AlreadyExists
      // race to tolerate.
      if (!observed) {
        const created = yield* diagnostics.createEndpointHealthcheck({
          accountId,
          ...desired,
        });
        return toAttributes(created, accountId);
      }

      // Sync — diff observed cloud state against desired; the update API
      // is a PUT carrying the full body, so send everything, but skip the
      // call entirely on a no-op. The name is create-only (a changed name
      // is routed to replacement by `diff`; the PUT echoes a new name back
      // without persisting it), so it never participates in the dirty
      // check and the observed name is kept as the source of truth.
      const dirty =
        observed.endpoint !== desired.endpoint ||
        observed.checkType !== desired.checkType;
      if (!dirty) {
        return toAttributes(observed, observed.accountId);
      }

      const updated = yield* diagnostics.updateEndpointHealthcheck({
        accountId: observed.accountId,
        id: observed.id ?? output!.healthcheckId,
        ...desired,
        name: observed.name ?? undefined,
      });
      // The PUT response echoes the request body; only `endpoint` is
      // actually mutable, so overlay the persisted (observed) name.
      return toAttributes(
        { ...updated, name: observed.name },
        observed.accountId,
      );
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped, non-paginated list (the whole collection comes
      // back in one response array). Skip accounts that lack the Magic
      // Transit / WAN entitlement (typed `Forbidden`) with an empty list.
      return yield* diagnostics.listEndpointHealthchecks({ accountId }).pipe(
        Effect.map((checks) => checks.map((hc) => toAttributes(hc, accountId))),
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* diagnostics
        .deleteEndpointHealthcheck({
          accountId: output.accountId,
          id: output.healthcheckId,
        })
        .pipe(
          Effect.catchTag("EndpointHealthcheckNotFound", () => Effect.void),
        );
    }),
  });

type ObservedHealthcheck = diagnostics.GetEndpointHealthcheckResponse & {
  accountId: string;
};

/**
 * Read a healthcheck by id, mapping "gone" (`EndpointHealthcheckNotFound`,
 * Cloudflare error code 1022) to `undefined`.
 */
const getHealthcheck = (accountId: string, id: string) =>
  diagnostics.getEndpointHealthcheck({ accountId, id }).pipe(
    Effect.map((hc): ObservedHealthcheck => ({ ...hc, accountId })),
    Effect.catchTag("EndpointHealthcheckNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Observe a healthcheck we believe exists (its id is cached on `output`).
 * A GET issued right after a create can transiently 404 while the new
 * state propagates, so bounded-retry on the typed
 * `EndpointHealthcheckNotFound` before treating the resource as gone —
 * this prevents a propagation blip from triggering a duplicate create.
 */
const observeExisting = (accountId: string, id: string) =>
  diagnostics.getEndpointHealthcheck({ accountId, id }).pipe(
    Effect.map((hc): ObservedHealthcheck => ({ ...hc, accountId })),
    Effect.retry({
      while: (e) => e._tag === "EndpointHealthcheckNotFound",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
    Effect.catchTag("EndpointHealthcheckNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a healthcheck by exact name. Names are not enforced unique on
 * Cloudflare's side; pick deterministically by id.
 */
const findByName = (accountId: string, name: string) =>
  diagnostics.listEndpointHealthchecks({ accountId }).pipe(
    Effect.map((list) =>
      list
        .filter((hc) => hc.name === name && typeof hc.id === "string")
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
    Effect.map(
      (hc): ObservedHealthcheck | undefined => hc && { ...hc, accountId },
    ),
  );

const createHealthcheckName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  hc:
    | ObservedHealthcheck
    | diagnostics.CreateEndpointHealthcheckResponse
    | diagnostics.UpdateEndpointHealthcheckResponse
    | diagnostics.ListEndpointHealthchecksResponse[number],
  accountId: string,
): EndpointHealthcheckAttributes => ({
  healthcheckId: hc.id ?? "",
  accountId,
  checkType: hc.checkType,
  endpoint: hc.endpoint,
  name: hc.name ?? "",
});
