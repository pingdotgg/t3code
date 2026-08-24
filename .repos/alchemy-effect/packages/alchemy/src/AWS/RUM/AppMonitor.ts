import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as rum from "@distilled.cloud/aws/rum";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Configuration for how the CloudWatch RUM web client collects data from
 * your application's user sessions.
 */
export interface AppMonitorConfiguration {
  /**
   * The ID of the Amazon Cognito identity pool used to authorize the sending
   * of data to RUM.
   */
  identityPoolId?: string;
  /**
   * Pages in your application excluded from RUM data collection. You can't
   * specify both `excludedPages` and `includedPages`.
   */
  excludedPages?: string[];
  /**
   * If your application has pages that RUM should collect data from and
   * others it should not, list the pages to collect here. You can't specify
   * both `excludedPages` and `includedPages`.
   */
  includedPages?: string[];
  /**
   * Pages to be displayed with a "favorite" icon in the CloudWatch RUM
   * console.
   */
  favoritePages?: string[];
  /**
   * The portion of user sessions to sample for RUM data collection, between
   * 0 and 1 (e.g. `0.1` samples 10% of sessions).
   * @default 0.1
   */
  sessionSampleRate?: number;
  /**
   * The ARN of the guest IAM role attached to the Cognito identity pool that
   * authorizes sending data to RUM.
   */
  guestRoleArn?: string;
  /**
   * Whether the RUM web client sets a cookie so that RUM can collect data
   * about user sessions across page views.
   * @default false
   */
  allowCookies?: boolean;
  /**
   * The kinds of telemetry to collect: `"errors"`, `"performance"`, and/or
   * `"http"`.
   */
  telemetries?: ("errors" | "performance" | "http")[];
  /**
   * Whether RUM sends client-side traces to AWS X-Ray for sampled sessions.
   * @default false
   */
  enableXRay?: boolean;
}

export interface AppMonitorProps {
  /**
   * Name of the app monitor. Changing the name replaces the app monitor.
   * @default ${app}-${stage}-${id}
   */
  appMonitorName?: string;
  /**
   * The top-level internet domain name your application has administrative
   * authority over, e.g. `example.com` or `*.example.com`. Specify exactly
   * one of `domain` or `domainList`.
   */
  domain?: string;
  /**
   * List of internet domain names your application has administrative
   * authority over (up to 5). Specify exactly one of `domain` or
   * `domainList`.
   */
  domainList?: string[];
  /**
   * Configuration for how the RUM web client collects session data.
   */
  appMonitorConfiguration?: AppMonitorConfiguration;
  /**
   * Whether the app monitor copies the telemetry data it collects to a
   * CloudWatch Logs log group in your account (retained for 30 days).
   * @default false
   */
  cwLogEnabled?: boolean;
  /**
   * Whether the app monitor accepts custom events sent by the RUM web
   * client.
   * @default "DISABLED"
   */
  customEvents?: "ENABLED" | "DISABLED";
  /**
   * Tags to apply to the app monitor. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AppMonitor extends Resource<
  "AWS.RUM.AppMonitor",
  AppMonitorProps,
  {
    /**
     * Name of the app monitor.
     */
    appMonitorName: string;
    /**
     * Unique ID of the app monitor (used by the RUM web client configuration).
     */
    appMonitorId: string;
    /**
     * ARN of the app monitor.
     */
    appMonitorArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon CloudWatch RUM app monitor that collects client-side telemetry
 * (page load times, JavaScript errors, user behavior) from your web
 * application.
 * @resource
 * @section Creating App Monitors
 * @example Monitor a single domain
 * ```typescript
 * import * as RUM from "alchemy/AWS/RUM";
 *
 * const monitor = yield* RUM.AppMonitor("SiteMonitor", {
 *   domain: "example.com",
 * });
 * ```
 *
 * @example Sample all sessions and collect every telemetry type
 * ```typescript
 * const monitor = yield* RUM.AppMonitor("SiteMonitor", {
 *   domain: "*.example.com",
 *   appMonitorConfiguration: {
 *     sessionSampleRate: 1,
 *     telemetries: ["errors", "performance", "http"],
 *     allowCookies: true,
 *   },
 * });
 * ```
 *
 * @section Log Retention and Custom Events
 * @example Copy telemetry to CloudWatch Logs and accept custom events
 * ```typescript
 * const monitor = yield* RUM.AppMonitor("SiteMonitor", {
 *   domainList: ["example.com", "app.example.com"],
 *   cwLogEnabled: true,
 *   customEvents: "ENABLED",
 * });
 * ```
 */
export const AppMonitor = Resource<AppMonitor>("AWS.RUM.AppMonitor");

/**
 * Raised when an `AppMonitor` is configured with both or neither of
 * `domain` / `domainList` — the API requires exactly one.
 */
export class RumAppMonitorInvalidDomains extends Data.TaggedError(
  "RumAppMonitorInvalidDomains",
)<{ message: string }> {}

const validateDomains = (
  props: Pick<AppMonitorProps, "domain" | "domainList">,
) => {
  const hasDomain = props.domain !== undefined;
  const hasDomainList = (props.domainList?.length ?? 0) > 0;
  if (hasDomain === hasDomainList) {
    return Effect.fail(
      new RumAppMonitorInvalidDomains({
        message: hasDomain
          ? "specify exactly one of domain or domainList, not both."
          : "an AppMonitor requires either domain or domainList.",
      }),
    );
  }
  return Effect.void;
};

const sameStringList = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

const desiredConfiguration = (
  props: AppMonitorProps,
): rum.AppMonitorConfiguration | undefined => {
  const c = props.appMonitorConfiguration;
  if (c === undefined) return undefined;
  return {
    IdentityPoolId: c.identityPoolId,
    ExcludedPages: c.excludedPages,
    IncludedPages: c.includedPages,
    FavoritePages: c.favoritePages,
    SessionSampleRate: c.sessionSampleRate,
    GuestRoleArn: c.guestRoleArn,
    AllowCookies: c.allowCookies,
    Telemetries: c.telemetries,
    EnableXRay: c.enableXRay,
  };
};

/** Compares only the fields the user explicitly configured against the observed cloud state. */
const configurationInSync = (
  observed: rum.AppMonitorConfiguration | undefined,
  desired: rum.AppMonitorConfiguration | undefined,
) => {
  if (desired === undefined) return true;
  const o = observed ?? {};
  return (
    (desired.IdentityPoolId === undefined ||
      o.IdentityPoolId === desired.IdentityPoolId) &&
    (desired.ExcludedPages === undefined ||
      sameStringList(o.ExcludedPages, desired.ExcludedPages)) &&
    (desired.IncludedPages === undefined ||
      sameStringList(o.IncludedPages, desired.IncludedPages)) &&
    (desired.FavoritePages === undefined ||
      sameStringList(o.FavoritePages, desired.FavoritePages)) &&
    (desired.SessionSampleRate === undefined ||
      o.SessionSampleRate === desired.SessionSampleRate) &&
    (desired.GuestRoleArn === undefined ||
      o.GuestRoleArn === desired.GuestRoleArn) &&
    (desired.AllowCookies === undefined ||
      (o.AllowCookies ?? false) === desired.AllowCookies) &&
    (desired.Telemetries === undefined ||
      sameStringList(o.Telemetries, desired.Telemetries)) &&
    (desired.EnableXRay === undefined ||
      (o.EnableXRay ?? false) === desired.EnableXRay)
  );
};

const appMonitorArn = (region: string, accountId: string, name: string) =>
  `arn:aws:rum:${region}:${accountId}:appmonitor/${name}`;

export const AppMonitorProvider = () =>
  Provider.effect(
    AppMonitor,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<AppMonitorProps, "appMonitorName">,
      ) {
        return (
          props.appMonitorName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const observeMonitor = (name: string) =>
        rum.getAppMonitor({ Name: name }).pipe(
          Effect.map((r) => r.AppMonitor),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      return AppMonitor.Provider.of({
        stables: ["appMonitorName", "appMonitorId", "appMonitorArn"],
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const summaries = yield* rum.listAppMonitors
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(summaries).flatMap((monitor) =>
              monitor.Name !== undefined && monitor.Id !== undefined
                ? [
                    {
                      appMonitorName: monitor.Name,
                      appMonitorId: monitor.Id,
                      appMonitorArn: appMonitorArn(
                        region,
                        accountId,
                        monitor.Name,
                      ),
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.appMonitorName ?? (yield* createName(id, olds ?? {}));
          const found = yield* observeMonitor(name);
          if (found?.Id === undefined) return undefined;
          const attrs = {
            appMonitorName: name,
            appMonitorId: found.Id,
            appMonitorArn: appMonitorArn(region, accountId, name),
          };
          const tags = Object.fromEntries(
            Object.entries(found.Tags ?? {}).filter(
              (t): t is [string, string] => t[1] !== undefined,
            ),
          );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          yield* validateDomains(news ?? {});
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          yield* validateDomains(news);
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.appMonitorName ?? (yield* createName(id, news));
          const arn = appMonitorArn(region, accountId, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...(news.tags ?? {}),
            ...internalTags,
          };
          const desiredConfig = desiredConfiguration(news);
          const desiredCwLogEnabled = news.cwLogEnabled ?? false;
          const desiredCustomEvents = news.customEvents ?? "DISABLED";

          // 1. OBSERVE — cloud state is authoritative; output is only a
          //    cache of the derived physical name.
          let live = yield* observeMonitor(name);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    the typed ConflictException, which we treat as a race and
          //    re-observe.
          if (live === undefined) {
            yield* rum
              .createAppMonitor({
                Name: name,
                Domain: news.domain,
                DomainList: news.domainList,
                Tags: desiredTags,
                AppMonitorConfiguration: desiredConfig,
                CwLogEnabled: desiredCwLogEnabled,
                CustomEvents: { Status: desiredCustomEvents },
              })
              .pipe(
                Effect.asVoid,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            live = yield* observeMonitor(name);
          }

          // 3. SYNC — diff the OBSERVED domain(s), configuration, log
          //    setting, and custom-events status against the desired state;
          //    update only on drift.
          const inSync =
            live !== undefined &&
            (news.domain === undefined || live.Domain === news.domain) &&
            (news.domainList === undefined ||
              sameStringList(live.DomainList, news.domainList)) &&
            configurationInSync(live.AppMonitorConfiguration, desiredConfig) &&
            (live.DataStorage?.CwLog?.CwLogEnabled ?? false) ===
              desiredCwLogEnabled &&
            (live.CustomEvents?.Status ?? "DISABLED") === desiredCustomEvents;
          if (!inSync) {
            yield* rum.updateAppMonitor({
              Name: name,
              Domain: news.domain,
              DomainList: news.domainList,
              AppMonitorConfiguration: desiredConfig,
              CwLogEnabled: desiredCwLogEnabled,
              CustomEvents: { Status: desiredCustomEvents },
            });
            live = yield* observeMonitor(name);
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time Tags only apply on first create).
          const currentTags = Object.fromEntries(
            Object.entries(live?.Tags ?? {}).filter(
              (t): t is [string, string] => t[1] !== undefined,
            ),
          );
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* rum.tagResource({
              ResourceArn: arn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* rum.untagResource({ ResourceArn: arn, TagKeys: removed });
          }

          yield* session.note(name);
          return {
            appMonitorName: name,
            appMonitorId: live?.Id ?? output?.appMonitorId!,
            appMonitorArn: arn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rum.deleteAppMonitor({ Name: output.appMonitorName }).pipe(
            // idempotent — the monitor may already be gone
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          // When cwLogEnabled is (or was ever) on, RUM vends telemetry into
          // a log group named
          //   /aws/vendedlogs/RUMService_{appMonitorName}{first 8 hex chars of Id}
          // and deleteAppMonitor does NOT remove it — without this reap every
          // deleted log-enabled monitor leaks an orphaned log group. Match
          // the observed groups against the monitor's Id so a sibling
          // monitor whose name extends ours is never reaped by accident.
          const logGroupPrefix = `/aws/vendedlogs/RUMService_${output.appMonitorName}`;
          const idHex = output.appMonitorId.replaceAll("-", "");
          const groups = yield* logs
            .describeLogGroups({ logGroupNamePrefix: logGroupPrefix })
            .pipe(Effect.map((r) => r.logGroups ?? []));
          yield* Effect.forEach(
            groups.flatMap((g) =>
              g.logGroupName !== undefined &&
              idHex.startsWith(g.logGroupName.slice(logGroupPrefix.length))
                ? [g.logGroupName]
                : [],
            ),
            (logGroupName) =>
              logs
                .deleteLogGroup({ logGroupName })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                ),
          );
        }),
      });
    }),
  );
