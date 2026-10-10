import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as HookInboxStore from "./HookInboxStore.ts";
import { sendUpstream, TUNNEL_OFFLINE_STATUS } from "./upstream.ts";

/** Statuses that mean the environment is not there; the whole inbox waits and backs off. */
const UNREACHABLE_STATUSES = new Set([502, 503, 504, TUNNEL_OFFLINE_STATUS]);
/**
 * Statuses that mean the environment is there but did not take this request
 * yet: its task's queue is full (429) or it failed while handling it (500).
 * The environment drops a delivery id it has already run, so retrying is safe.
 */
const BUSY_STATUSES = new Set([429, 500]);
/** When a run itself fails, the next one is tried after this long. */
const RUN_FAILURE_RETRY_MS = 60_000;

type Call<A> = Effect.Effect<A, never, Alchemy.RuntimeContext>;

/**
 * One per managed endpoint, addressed by endpoint key. Holds webhook requests
 * the environment could not take, in SQLite, and pushes them back through
 * its tunnel from the alarm, oldest first, backing off while it stays away.
 */
export class HookInboxObject extends Cloudflare.DurableObject<
  HookInboxObject,
  {
    /** Holds a request for `baseUrl`; false when the inbox is full and nothing was stored. */
    readonly hold: (hook: HookInboxStore.HeldHook, baseUrl: string) => Call<boolean>;
    /** The environment is back at `baseUrl`: deliver what is waiting now. */
    readonly wake: (baseUrl: string) => Call<boolean>;
    readonly clear: () => Call<void>;
  }
>()("HookInboxObject") {}

/**
 * Each call into an inbox is its own trace: the alarm has no parent, and a
 * hold arrives over Durable Object RPC without the forwarding span. The
 * object's name is the endpoint key, which the forward spans carry too.
 */
const withInboxSpan =
  (name: string, inboxId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(name, { root: true, attributes: { "relay.hook.endpoint_key": inboxId } }),
    );

const deliver = (baseUrl: string, hook: HookInboxStore.HeldHook) =>
  sendUpstream(baseUrl, hook).pipe(
    Effect.result,
    Effect.map((result) => {
      // Unreachable or timed out: a timeout may still have run it, and the
      // environment drops a delivery id it has already seen.
      if (Result.isFailure(result)) {
        return { outcome: "unreachable" as const, reason: result.failure._tag };
      }
      if (Option.isNone(result.success))
        return { outcome: "unreachable" as const, reason: "timeout" };
      const status = result.success.value.status;
      const upstreamOutcome = result.success.value.outcome;
      const outcome: HookInboxStore.DeliveryOutcome = UNREACHABLE_STATUSES.has(status)
        ? "unreachable"
        : BUSY_STATUSES.has(status)
          ? "busy"
          : "delivered";
      return { outcome, reason: `status ${status}`, upstreamOutcome };
    }),
    Effect.tap(({ upstreamOutcome }) =>
      upstreamOutcome === undefined
        ? Effect.void
        : Effect.annotateCurrentSpan({ "relay.hook.upstream_outcome": upstreamOutcome }),
    ),
    Effect.tap(({ outcome, reason }) =>
      outcome === "delivered"
        ? Effect.void
        : Effect.logInfo("Held webhook not delivered yet", {
            outcome,
            reason,
            deliveryId: hook.id,
          }),
    ),
    Effect.map(({ outcome }) => outcome),
    Effect.provide(FetchHttpClient.layer),
  );

export const layer = HookInboxObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // The init phase returns the per-instance Effect, which alchemy runs once
    // per object; only that inner Effect may touch storage.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const layerSql = SqliteClient.layer({ storage: state.raw.storage });
      // Inboxes are opened by endpoint key, so spans line up with the
      // forward spans that held their requests.
      const inboxId = state.raw.id.name ?? state.raw.id.toString();
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(layerSql), Effect.orDie);
      yield* run(HookInboxStore.migrate);

      /** Moves the alarm to `at`, unless one is already due sooner. */
      const scheduleBy = (at: number) =>
        Effect.gen(function* () {
          const current = yield* state.storage.getAlarm();
          if (current === null || current > at) yield* state.storage.setAlarm(at);
        });

      return {
        hold: (hook: HookInboxStore.HeldHook, baseUrl: string) =>
          Effect.gen(function* () {
            const dueAt = yield* run(HookInboxStore.hold(hook, baseUrl));
            yield* Effect.annotateCurrentSpan({ "relay.inbox.stored": dueAt !== null });
            if (dueAt === null) return false;
            yield* scheduleBy(dueAt);
            return true;
          }).pipe(withInboxSpan("relay.inbox.hold", inboxId)),
        wake: (baseUrl: string) =>
          Effect.gen(function* () {
            const pending = yield* run(HookInboxStore.wake(baseUrl));
            yield* Effect.annotateCurrentSpan({ "relay.inbox.pending": pending });
            if (pending) yield* state.storage.setAlarm(yield* Clock.currentTimeMillis);
            return pending;
          }).pipe(withInboxSpan("relay.inbox.wake", inboxId)),
        clear: () =>
          Effect.gen(function* () {
            yield* run(HookInboxStore.clear);
            yield* state.storage.deleteAlarm();
          }).pipe(withInboxSpan("relay.inbox.clear", inboxId)),
        alarm: () =>
          run(HookInboxStore.deliverDue(deliver)).pipe(
            // A wake during this run may already have asked for an earlier
            // run; a backoff must not push it out.
            Effect.flatMap((nextAt) => (nextAt === null ? Effect.void : scheduleBy(nextAt))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Held webhook delivery run failed", { cause }).pipe(
                Effect.andThen(Effect.annotateCurrentSpan({ "relay.inbox.run_result": "failed" })),
                Effect.andThen(Clock.currentTimeMillis),
                Effect.flatMap((now) => scheduleBy(now + RUN_FAILURE_RETRY_MS)),
              ),
            ),
            withInboxSpan("relay.inbox.deliver", inboxId),
          ),
      };
    });
  }),
);
