import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchCeTags, pinCe, syncCeTags, toResourceTags } from "./common.ts";

export interface AnomalyMonitorProps {
  /**
   * Name of the anomaly monitor. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Renaming updates the monitor in place.
   */
  monitorName?: string;
  /**
   * The type of monitor.
   *
   * - `DIMENSIONAL` — monitors spend grouped by a built-in dimension
   *   (`monitorDimension`). AWS allows only one `SERVICE`-dimension monitor
   *   per account.
   * - `CUSTOM` — monitors spend matching a custom `monitorSpecification`
   *   expression (linked accounts, cost allocation tags, or cost categories).
   *
   * Changing the type replaces the monitor.
   */
  monitorType: "DIMENSIONAL" | "CUSTOM" | (string & {});
  /**
   * The dimension to group spend by for `DIMENSIONAL` monitors. Required when
   * `monitorType` is `DIMENSIONAL`. Changing it replaces the monitor.
   */
  monitorDimension?: "SERVICE" | (string & {});
  /**
   * The expression selecting the spend a `CUSTOM` monitor evaluates —
   * linked accounts, cost allocation tags, or cost categories (raw
   * Cost Explorer `Expression` shape). Required when `monitorType` is
   * `CUSTOM`. Changing it replaces the monitor.
   */
  monitorSpecification?: ce.Expression;
  /**
   * User-defined tags to apply to the monitor.
   */
  tags?: Record<string, string>;
}

export interface AnomalyMonitor extends Resource<
  "AWS.CostExplorer.AnomalyMonitor",
  AnomalyMonitorProps,
  {
    /** ARN of the anomaly monitor. */
    monitorArn: string;
    /** Name of the anomaly monitor. */
    monitorName: string;
    /** Type of the monitor (`DIMENSIONAL` or `CUSTOM`). */
    monitorType: string;
    /** Current tags on the monitor. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Cost Explorer anomaly detection monitor. Monitors evaluate your spend for
 * unusual patterns; pair with an
 * {@link ../AnomalySubscription | AnomalySubscription} to receive alerts.
 *
 * Cost Explorer is a global service — all calls are pinned to `us-east-1`
 * regardless of the stack region. Monitors are free and take effect
 * immediately.
 *
 * @resource
 * @section Creating Anomaly Monitors
 * @example Custom monitor scoped by a cost allocation tag
 * ```typescript
 * import * as CostExplorer from "alchemy/AWS/CostExplorer";
 *
 * const monitor = yield* CostExplorer.AnomalyMonitor("TeamSpend", {
 *   monitorType: "CUSTOM",
 *   monitorSpecification: {
 *     Tags: { Key: "CostCenter", Values: ["10000"] },
 *   },
 * });
 * ```
 *
 * @example Dimensional monitor across all AWS services
 * ```typescript
 * const monitor = yield* CostExplorer.AnomalyMonitor("ServiceSpend", {
 *   monitorType: "DIMENSIONAL",
 *   monitorDimension: "SERVICE",
 * });
 * ```
 */
export const AnomalyMonitor = Resource<AnomalyMonitor>(
  "AWS.CostExplorer.AnomalyMonitor",
);

export const AnomalyMonitorProvider = () =>
  Provider.effect(
    AnomalyMonitor,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { monitorName?: string | undefined },
      ) {
        return (
          props.monitorName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      // Observe by ARN — the typed miss tag is UnknownMonitorException.
      const getByArn = (monitorArn: string) =>
        pinCe(ce.getAnomalyMonitors({ MonitorArnList: [monitorArn] })).pipe(
          Effect.map((r) => r.AnomalyMonitors[0]),
          Effect.catchTag("UnknownMonitorException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Fallback observation when no ARN is cached: scan all monitors for the
      // deterministic physical name.
      const findByName = (monitorName: string) =>
        pinCe(
          ce.getAnomalyMonitors.items({}).pipe(
            Stream.filter((m) => m.MonitorName === monitorName),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.map((chunk) => Array.from(chunk)[0]));

      const toAttrs = Effect.fn(function* (live: ce.AnomalyMonitor) {
        const monitorArn = live.MonitorArn!;
        return {
          monitorArn,
          monitorName: live.MonitorName,
          monitorType: live.MonitorType,
          tags: yield* fetchCeTags(monitorArn),
        };
      });

      return AnomalyMonitor.Provider.of({
        stables: ["monitorArn"],
        list: () =>
          Effect.gen(function* () {
            const monitors = yield* pinCe(
              ce.getAnomalyMonitors.items({}).pipe(Stream.runCollect),
            ).pipe(Effect.map((chunk) => Array.from(chunk)));
            return yield* Effect.forEach(
              monitors.filter((m) => m.MonitorArn !== undefined),
              toAttrs,
              { concurrency: 10 },
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const live = output?.monitorArn
            ? yield* getByArn(output.monitorArn)
            : yield* findByName(yield* createName(id, olds ?? {}));
          if (live?.MonitorArn === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          const prior: Partial<AnomalyMonitorProps> = olds ?? {};
          if (prior.monitorType === undefined) return;
          // Only the name is mutable via UpdateAnomalyMonitor — the type,
          // dimension, and specification are create-only.
          if (
            prior.monitorType !== news.monitorType ||
            prior.monitorDimension !== news.monitorDimension ||
            JSON.stringify(prior.monitorSpecification) !==
              JSON.stringify(news.monitorSpecification)
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // OBSERVE — cloud state is authoritative; output is only an ARN
          // cache. Monitor names are not unique identity (the ARN is), so the
          // find-by-name fallback only adopts a monitor whose create-only
          // props already match the desired state. This keeps replacement
          // correct: while the engine replaces a monitor (spec change), the
          // old same-name monitor is still live and must NOT be adopted.
          const matchesDesired = (m: ce.AnomalyMonitor) =>
            m.MonitorType === news.monitorType &&
            m.MonitorDimension === news.monitorDimension &&
            JSON.stringify(m.MonitorSpecification ?? null) ===
              JSON.stringify(news.monitorSpecification ?? null);
          const live = output?.monitorArn
            ? yield* getByArn(output.monitorArn)
            : yield* findByName(name).pipe(
                Effect.map((m) =>
                  m !== undefined && matchesDesired(m) ? m : undefined,
                ),
              );

          let monitorArn = live?.MonitorArn;
          if (monitorArn === undefined) {
            // ENSURE — create if missing. Monitor names are unique per
            // account; tolerate the AlreadyExists race by adopting the
            // same-name monitor only when its create-only props match the
            // desired state (a mismatch means a genuine conflict — e.g. a
            // replacement targeting an explicit name — and must surface).
            const created = yield* pinCe(
              ce.createAnomalyMonitor({
                AnomalyMonitor: {
                  MonitorName: name,
                  MonitorType: news.monitorType,
                  MonitorDimension: news.monitorDimension,
                  MonitorSpecification: news.monitorSpecification,
                },
                ResourceTags: toResourceTags(desiredTags),
              }),
            ).pipe(
              Effect.catchTag("AnomalyMonitorAlreadyExists", (error) =>
                findByName(name).pipe(
                  Effect.flatMap((m) =>
                    m?.MonitorArn !== undefined && matchesDesired(m)
                      ? Effect.succeed({ MonitorArn: m.MonitorArn })
                      : Effect.fail(error),
                  ),
                ),
              ),
            );
            monitorArn = created.MonitorArn;
          } else if (live!.MonitorName !== name) {
            // SYNC — the name is the only mutable aspect of a monitor.
            yield* pinCe(
              ce.updateAnomalyMonitor({
                MonitorArn: monitorArn,
                MonitorName: name,
              }),
            );
          }

          // SYNC TAGS — diff against observed cloud tags.
          yield* syncCeTags(monitorArn, desiredTags);

          yield* session.note(monitorArn);
          return {
            monitorArn,
            monitorName: name,
            monitorType: news.monitorType,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* pinCe(
            ce.deleteAnomalyMonitor({ MonitorArn: output.monitorArn }),
          ).pipe(Effect.catchTag("UnknownMonitorException", () => Effect.void));
        }),
      });
    }),
  );
