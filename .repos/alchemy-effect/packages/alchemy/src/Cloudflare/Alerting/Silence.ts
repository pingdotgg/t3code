import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Alerting.Silence" as const;
type TypeId = typeof TypeId;

export interface SilenceProps {
  /**
   * The notification policy to silence. References a
   * {@link NotificationPolicy} id. Changing the policy triggers a
   * replacement — the silence update API cannot move a silence to a
   * different policy.
   */
  policyId: string;
  /**
   * When the silence window starts, as an RFC3339/ISO8601 timestamp (e.g.
   * `2026-07-01T00:00:00Z`). Must be within 90 days of now — Cloudflare
   * rejects windows further out with `InvalidSilence`. Pass an explicit,
   * deterministic value; the provider never derives times from the clock.
   * Mutable — updated in place.
   */
  startTime: string;
  /**
   * When the silence window ends, as an RFC3339/ISO8601 timestamp. Must be
   * after `startTime` (`InvalidSilence` otherwise).
   * Mutable — updated in place.
   */
  endTime: string;
}

export interface SilenceAttributes {
  /** Cloudflare-assigned silence id. */
  silenceId: string;
  /** Account that owns this silence. */
  accountId: string;
  /** The notification policy this silence applies to. */
  policyId: string;
  /** When the silence window starts (ISO8601). */
  startTime: string;
  /** When the silence window ends (ISO8601). */
  endTime: string;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-modified timestamp. */
  updatedAt: string | undefined;
}

export type Silence = Resource<
  TypeId,
  SilenceProps,
  SilenceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Notifications silence window.
 *
 * A silence suppresses notification dispatches for a
 * {@link NotificationPolicy} between `startTime` and `endTime` — e.g.
 * during a planned maintenance window. The window times are explicit
 * ISO8601 props supplied by you; Cloudflare requires the start time to be
 * within 90 days of now.
 *
 * Note: the create API returns no id, so the provider resolves the created
 * silence by listing and matching on `(policyId, startTime, endTime)`. Two
 * silences sharing the exact same policy and window are indistinguishable.
 * @resource
 * @product Alerting
 * @category Observability & Analytics
 * @section Creating a silence
 * @example Silence a policy during a maintenance window
 * ```typescript
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 *
 * yield* Cloudflare.Alerting.Silence("MaintenanceWindow", {
 *   policyId: policy.policyId,
 *   startTime: "2026-07-01T00:00:00Z",
 *   endTime: "2026-07-01T04:00:00Z",
 * });
 * ```
 *
 * @section Updating the window
 * @example Extend the silence end time in place
 * Window times are mutable — changing them updates the existing silence.
 * ```typescript
 * yield* Cloudflare.Alerting.Silence("MaintenanceWindow", {
 *   policyId: policy.policyId,
 *   startTime: "2026-07-01T00:00:00Z",
 *   endTime: "2026-07-01T08:00:00Z",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/notifications/
 */
export const Silence = Resource<Silence>(TypeId);

/**
 * Returns true if the given value is a Silence resource.
 */
export const isSilence = (value: unknown): value is Silence =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SilenceProvider = () =>
  Provider.succeed(Silence, {
    stables: ["silenceId", "accountId", "policyId", "createdAt"],

    // Silences are account-scoped; listSilences enumerates every silence in
    // the account and the response carries the full attribute shape, so no
    // per-item hydration is needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* alerting.listSilences.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map(narrowSilence)
              .filter((s): s is ObservedSilence => s !== undefined)
              .map((s) => toSilenceAttributes(s, accountId)),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The silence update body carries no policyId — a silence cannot be
      // moved to a different policy, so a policy change is a replacement.
      // policyId is Input<string>; compare only once both are concrete.
      const o = olds as SilenceProps;
      const n = news as SilenceProps;
      const oldPolicyId =
        output?.policyId ??
        (typeof o.policyId === "string" ? o.policyId : undefined);
      if (
        oldPolicyId !== undefined &&
        typeof n.policyId === "string" &&
        oldPolicyId !== n.policyId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted silence id.
      if (output?.silenceId) {
        const observed = yield* observeSilence(acct, output.silenceId);
        if (observed) return toSilenceAttributes(observed, acct);
        return undefined;
      }

      // Cold read: no persisted id (state-persistence failure) — match on
      // the silence identity `(policyId, startTime, endTime)`. Silences
      // carry no ownership markers, so we cannot prove we created a match:
      // brand it `Unowned` so the engine gates takeover behind adoption.
      const o = olds as SilenceProps | undefined;
      const policyId = typeof o?.policyId === "string" ? o.policyId : undefined;
      if (policyId && o?.startTime && o?.endTime) {
        const match = yield* findSilence(
          acct,
          policyId,
          o.startTime,
          o.endTime,
        );
        if (match) return Unowned(toSilenceAttributes(match, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs are resolved to concrete values by the engine before
      // reconcile runs.
      const policyId = news.policyId as string;

      // 1. Observe — by cached id first, then by silence identity.
      let observed: ObservedSilence | undefined;
      if (output?.silenceId) {
        observed = yield* observeSilence(accountId, output.silenceId);
      }
      if (!observed) {
        observed = yield* findSilence(
          accountId,
          policyId,
          news.startTime,
          news.endTime,
        );
      }

      // 2. Ensure — create when missing. The create response carries no
      //    id, so resolve the created silence by listing and matching on
      //    `(policyId, startTime, endTime)` with a short bounded retry for
      //    read-after-write consistency. A concurrent create of the same
      //    window surfaces as `SilenceAlreadyExists`: converge by reusing
      //    the silence that won the race.
      if (!observed) {
        yield* alerting
          .createSilence({
            accountId,
            body: [
              {
                policyId,
                startTime: news.startTime,
                endTime: news.endTime,
              },
            ],
          })
          .pipe(
            Effect.catchTag("SilenceAlreadyExists", (error) =>
              findSilence(
                accountId,
                policyId,
                news.startTime,
                news.endTime,
              ).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.void : Effect.fail(error),
                ),
              ),
            ),
          );
        observed = yield* findSilence(
          accountId,
          policyId,
          news.startTime,
          news.endTime,
        ).pipe(
          Effect.flatMap((found) =>
            found ? Effect.succeed(found) : Effect.fail(new SilencePending()),
          ),
          Effect.retry({
            while: (e) => e._tag === "SilencePending",
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(8),
            ]),
          }),
        );
        return toSilenceAttributes(observed, accountId);
      }

      // 3. Sync — diff the observed window against the desired one
      //    (instant-equal, so `00:00:00Z` matches `00:00:00+00:00`) and
      //    PUT only on drift.
      if (
        !sameInstant(observed.startTime, news.startTime) ||
        !sameInstant(observed.endTime, news.endTime)
      ) {
        yield* alerting.updateSilence({
          accountId,
          body: [
            {
              id: observed.id,
              startTime: news.startTime,
              endTime: news.endTime,
            },
          ],
        });
        const fresh = yield* observeSilence(accountId, observed.id);
        return toSilenceAttributes(fresh ?? observed, accountId);
      }

      // 4. Return.
      return toSilenceAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* alerting
        .deleteSilence({
          accountId: output.accountId,
          silenceId: output.silenceId,
        })
        .pipe(Effect.catchTag("SilenceNotFound", () => Effect.void));
    }),
  });

/** Created silence not yet visible in the list — retried internally. */
class SilencePending extends Data.TaggedError("SilencePending") {}

interface ObservedSilence {
  readonly id: string;
  readonly policyId?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const narrowSilence = (raw: {
  id?: string | null;
  policyId?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}): ObservedSilence | undefined =>
  raw.id == null
    ? undefined
    : {
        id: raw.id,
        policyId: undef(raw.policyId),
        startTime: undef(raw.startTime),
        endTime: undef(raw.endTime),
        createdAt: undef(raw.createdAt),
        updatedAt: undef(raw.updatedAt),
      };

const observeSilence = (accountId: string, silenceId: string) =>
  alerting.getSilence({ accountId, silenceId }).pipe(
    Effect.map((s) => narrowSilence({ ...s, id: s.id ?? silenceId })),
    Effect.catchTag("SilenceNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Locate a silence by its identity `(policyId, startTime, endTime)`.
 * Timestamps are compared as instants so formatting differences (trailing
 * `Z` vs `+00:00`, fractional seconds) don't defeat the match.
 */
const findSilence = (
  accountId: string,
  policyId: string,
  startTime: string,
  endTime: string,
) =>
  alerting.listSilences.items({ accountId }).pipe(
    Stream.filter(
      (s) =>
        s.id != null &&
        s.policyId === policyId &&
        sameInstant(undef(s.startTime), startTime) &&
        sameInstant(undef(s.endTime), endTime),
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map((s) => (s === undefined ? undefined : narrowSilence(s))),
  );

/** Compare two ISO8601 timestamps by the instant they denote. */
const sameInstant = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
};

const toSilenceAttributes = (
  observed: ObservedSilence,
  accountId: string,
): SilenceAttributes => ({
  silenceId: observed.id,
  accountId,
  policyId: observed.policyId ?? "",
  startTime: observed.startTime ?? "",
  endTime: observed.endTime ?? "",
  createdAt: observed.createdAt,
  updatedAt: observed.updatedAt,
});
