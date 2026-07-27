import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface EventSourcesConfigProps {
  /**
   * Consume Amazon CodeGuru Profiler recommendations as an event source so
   * DevOps Guru can surface them as proactive insights.
   * @default false
   */
  amazonCodeGuruProfiler?: boolean;
}

export interface EventSourcesConfig extends Resource<
  "AWS.DevOpsGuru.EventSourcesConfig",
  EventSourcesConfigProps,
  {
    /** Whether CodeGuru Profiler recommendations are consumed. */
    amazonCodeGuruProfiler: boolean;
  },
  never,
  Providers
> {}

/**
 * The DevOps Guru event sources configuration — the account/region singleton
 * that controls which integrated services DevOps Guru consumes
 * recommendations from as event sources. The one supported source is Amazon
 * CodeGuru Profiler: when enabled, profiler recommendations surface as
 * DevOps Guru proactive insights.
 *
 * An account has exactly one configuration, so this resource is a
 * capture-and-restore singleton: adopting an enabled configuration that
 * Alchemy did not create requires `--adopt`. Destroying the resource
 * restores the default (disabled).
 *
 * @section Enabling Event Sources
 * @example Consume CodeGuru Profiler Recommendations
 * ```typescript
 * const eventSources = yield* DevOpsGuru.EventSourcesConfig("EventSources", {
 *   amazonCodeGuruProfiler: true,
 * });
 * ```
 * @resource
 */
export const EventSourcesConfig = Resource<EventSourcesConfig>(
  "AWS.DevOpsGuru.EventSourcesConfig",
);

/**
 * Concurrent `UpdateEventSourcesConfig` calls conflict server-side — retry
 * the typed conflict tag on a short bounded schedule.
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryUpdateConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
  });

export const EventSourcesConfigProvider = () =>
  Provider.effect(
    EventSourcesConfig,
    Effect.gen(function* () {
      // Observe the live configuration. An absent section or status means
      // the account default (disabled).
      const observe = Effect.gen(function* () {
        const { EventSources } = yield* devopsguru.describeEventSourcesConfig(
          {},
        );
        return {
          amazonCodeGuruProfiler:
            EventSources?.AmazonCodeGuruProfiler?.Status === "ENABLED",
        };
      });

      const setProfiler = Effect.fn(function* (
        status: devopsguru.EventSourceOptInStatus,
      ) {
        yield* retryUpdateConflict(
          devopsguru.updateEventSourcesConfig({
            EventSources: { AmazonCodeGuruProfiler: { Status: status } },
          }),
        );
      });

      return {
        // Account/region singleton — surfaced only when non-default.
        list: () =>
          observe.pipe(
            Effect.map((observed) =>
              observed.amazonCodeGuruProfiler ? [observed] : [],
            ),
          ),

        read: Effect.fn(function* ({ output }) {
          const observed = yield* observe;
          if (!observed.amazonCodeGuruProfiler) {
            return undefined;
          }
          // The configuration can't carry ownership tags — an enabled
          // configuration we have no record of belongs to someone else
          // until explicitly adopted.
          return output !== undefined ? observed : Unowned(observed);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. OBSERVE — the live configuration is authoritative.
          const observed = yield* observe;

          // 2. SYNC — apply only when drifted.
          const desired = news.amazonCodeGuruProfiler ?? false;
          if (observed.amazonCodeGuruProfiler !== desired) {
            yield* setProfiler(desired ? "ENABLED" : "DISABLED");
          }

          // 3. RETURN fresh attributes.
          const final = yield* observe;
          yield* session.note(
            `amazonCodeGuruProfiler: ${final.amazonCodeGuruProfiler}`,
          );
          return final;
        }),

        // "Deleting" the singleton restores the default (disabled).
        delete: Effect.fn(function* () {
          const observed = yield* observe;
          if (observed.amazonCodeGuruProfiler) {
            yield* setProfiler("DISABLED");
          }
        }),
      };
    }),
  );
