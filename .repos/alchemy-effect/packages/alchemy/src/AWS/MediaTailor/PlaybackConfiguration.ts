import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * CDN routing configuration for ad and content segment delivery.
 */
export interface PlaybackConfigurationCdn {
  /**
   * A non-default content delivery network (CDN) prefix that MediaTailor
   * routes ad segment requests through, e.g. a CloudFront distribution in
   * front of `ads.mediatailor.<region>.amazonaws.com`.
   */
  adSegmentUrlPrefix?: string;
  /**
   * A content delivery network (CDN) prefix that content segment URLs in
   * manifests are rewritten to, so players request content through the CDN.
   */
  contentSegmentUrlPrefix?: string;
}

/**
 * DASH manifest handling configuration.
 */
export interface PlaybackConfigurationDash {
  /**
   * Where the `Location` element is placed in the DASH manifest.
   * @default "EMT_DEFAULT"
   */
  mpdLocation?: string;
  /**
   * Whether the origin server produces single-period or multi-period DASH
   * manifests. One of `SINGLE_PERIOD` or `MULTI_PERIOD`.
   * @default "MULTI_PERIOD"
   */
  originManifestType?: "SINGLE_PERIOD" | "MULTI_PERIOD";
}

/**
 * Controls how MediaTailor suppresses ad insertion near the live edge.
 */
export interface PlaybackConfigurationAvailSuppression {
  /**
   * `BEHIND_LIVE_EDGE` suppresses ads behind the configured point in the
   * stream; `AFTER_LIVE_EDGE` suppresses ads after it.
   * @default "OFF"
   */
  mode?: "OFF" | "BEHIND_LIVE_EDGE" | "AFTER_LIVE_EDGE";
  /**
   * A live-edge offset timestamp (HH:MM:SS) that defines the suppression
   * boundary.
   */
  value?: string;
  /**
   * `PARTIAL_AVAIL` fills partial ad breaks; `FULL_AVAIL_ONLY` only fills
   * complete ad breaks.
   */
  fillPolicy?: "FULL_AVAIL_ONLY" | "PARTIAL_AVAIL";
}

/**
 * Bumpers are short branded videos played before and after ad breaks.
 */
export interface PlaybackConfigurationBumper {
  /** URL of the bumper asset played before each ad break. */
  startUrl?: string;
  /** URL of the bumper asset played after each ad break. */
  endUrl?: string;
}

/**
 * Configuration for pre-roll ad insertion on live streams.
 */
export interface PlaybackConfigurationLivePreRoll {
  /** The ad decision server URL used for live pre-roll ads. */
  adDecisionServerUrl?: string;
  /**
   * Maximum allowed duration for the pre-roll ad avail, e.g. `"30 seconds"`.
   * Sent to the API in whole seconds (`MaxDurationSeconds`).
   */
  maxDuration?: Duration.Input;
}

/**
 * CloudWatch log configuration for the playback configuration
 * (`ConfigureLogsForPlaybackConfiguration`).
 */
export interface PlaybackConfigurationLogs {
  /**
   * The percentage of session logs MediaTailor sends to CloudWatch Logs
   * (0–100). Session logs land in the `MediaTailor/PlaybackConfiguration`
   * log group (legacy) or the vended-log delivery you configure.
   */
  percentEnabled: number;
  /**
   * The method MediaTailor uses to deliver the logs:
   * `LEGACY_CLOUDWATCH` (direct to CloudWatch Logs) and/or `VENDED_LOGS`
   * (CloudWatch vended log delivery to CloudWatch/S3/Firehose).
   */
  enabledLoggingStrategies?: ("LEGACY_CLOUDWATCH" | "VENDED_LOGS")[];
}

/**
 * Rules that customize how MediaTailor processes the origin manifest.
 */
export interface PlaybackConfigurationManifestProcessingRules {
  /**
   * When enabled, `EXT-X-CUE-IN`/`EXT-X-CUE-OUT` (and other ad markers) from
   * the origin manifest pass through into the personalized manifest.
   * @default false
   */
  adMarkerPassthroughEnabled?: boolean;
}

export interface PlaybackConfigurationProps {
  /**
   * The identifier for the playback configuration. Maximum 64 characters,
   * letters, digits, hyphens, and underscores.
   *
   * Changing the name replaces the configuration.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The URL for the ad decision server (ADS). This includes the
   * specification of static parameters and placeholders for dynamic
   * parameters, e.g. `https://ads.example.com/vast?ip=[client_ip]`.
   * Maximum 25,000 characters.
   */
  adDecisionServerUrl: string;
  /**
   * The URL prefix for the source of the content stream (the origin server),
   * minus the asset ID. Maximum 512 characters.
   */
  videoContentSourceUrl: string;
  /**
   * The URL for a video asset to transcode and use to fill in time that's
   * not used by ads. MediaTailor shows the slate when there is no ad to
   * fill an avail.
   */
  slateAdUrl?: string;
  /**
   * Defines the maximum duration of underfilled ad time (e.g. `"2 seconds"`)
   * allowed in an ad break. Underfilled time beyond the threshold is not
   * filled with slate. Sent to the API in whole seconds
   * (`PersonalizationThresholdSeconds`).
   */
  personalizationThreshold?: Duration.Input;
  /**
   * The name that is used to associate this playback configuration with a
   * custom transcode profile (set up with AWS Support).
   */
  transcodeProfileName?: string;
  /**
   * The setting that controls whether players can use stitched or guided ad
   * insertion. One of `STITCHED_ONLY` or `PLAYER_SELECT`.
   * @default "STITCHED_ONLY"
   */
  insertionMode?: "STITCHED_ONLY" | "PLAYER_SELECT";
  /**
   * CDN prefixes for routing ad and content segment requests.
   */
  cdnConfiguration?: PlaybackConfigurationCdn;
  /**
   * DASH manifest configuration.
   */
  dashConfiguration?: PlaybackConfigurationDash;
  /**
   * Ad suppression behavior near the live edge.
   */
  availSuppression?: PlaybackConfigurationAvailSuppression;
  /**
   * Bumper videos played before and after ad breaks.
   */
  bumper?: PlaybackConfigurationBumper;
  /**
   * Pre-roll ad insertion for live streams.
   */
  livePreRollConfiguration?: PlaybackConfigurationLivePreRoll;
  /**
   * Origin-manifest processing rules (e.g. ad marker passthrough).
   */
  manifestProcessingRules?: PlaybackConfigurationManifestProcessingRules;
  /**
   * CloudWatch session-log configuration. Omit (or set `percentEnabled: 0`)
   * to disable session logging.
   */
  logConfiguration?: PlaybackConfigurationLogs;
  /**
   * Tags to apply to the playback configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PlaybackConfiguration extends Resource<
  "AWS.MediaTailor.PlaybackConfiguration",
  PlaybackConfigurationProps,
  {
    /** The identifier for the playback configuration. */
    name: string;
    /** The ARN of the playback configuration. */
    playbackConfigurationArn: string;
    /** The URL that the player accesses to get a manifest from MediaTailor. */
    playbackEndpointPrefix: string;
    /** The URL that the player uses to initialize a session that uses client-side reporting. */
    sessionInitializationEndpointPrefix: string;
    /** The HLS manifest endpoint prefix, if HLS is configured. */
    hlsManifestEndpointPrefix: string | undefined;
    /** The DASH manifest endpoint prefix, if DASH is configured. */
    dashManifestEndpointPrefix: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaTailor playback configuration for server-side ad
 * insertion (SSAI) into HLS and DASH video streams.
 *
 * @resource
 * @section Creating Playback Configurations
 * @example Basic ad-inserted stream
 * ```typescript
 * import * as MediaTailor from "alchemy/AWS/MediaTailor";
 *
 * const config = yield* MediaTailor.PlaybackConfiguration("Ads", {
 *   adDecisionServerUrl: "https://ads.example.com/vast?ip=[client_ip]",
 *   videoContentSourceUrl: "https://origin.example.com/live",
 * });
 * ```
 *
 * @example Slate fill and personalization threshold
 * ```typescript
 * const config = yield* MediaTailor.PlaybackConfiguration("Ads", {
 *   adDecisionServerUrl: "https://ads.example.com/vast",
 *   videoContentSourceUrl: "https://origin.example.com/vod",
 *   slateAdUrl: "https://origin.example.com/slate.mp4",
 *   personalizationThreshold: "2 seconds",
 * });
 * ```
 *
 * @section Manifest Behavior
 * @example Ad marker passthrough and avail suppression
 * ```typescript
 * const config = yield* MediaTailor.PlaybackConfiguration("Live", {
 *   adDecisionServerUrl: "https://ads.example.com/vast",
 *   videoContentSourceUrl: "https://origin.example.com/live",
 *   manifestProcessingRules: { adMarkerPassthroughEnabled: true },
 *   availSuppression: { mode: "BEHIND_LIVE_EDGE", value: "00:00:30" },
 * });
 * ```
 *
 * @section Session Logging
 * @example Send 10% of session logs to CloudWatch
 * ```typescript
 * const config = yield* MediaTailor.PlaybackConfiguration("Logged", {
 *   adDecisionServerUrl: "https://ads.example.com/vast",
 *   videoContentSourceUrl: "https://origin.example.com/live",
 *   logConfiguration: { percentEnabled: 10 },
 * });
 * ```
 */
export const PlaybackConfiguration = Resource<PlaybackConfiguration>(
  "AWS.MediaTailor.PlaybackConfiguration",
);

/**
 * Raised when MediaTailor returns a playback configuration without the
 * attributes the provider needs (ARN and playback endpoints). This indicates
 * an unexpected API response rather than a user error.
 */
export class MediaTailorIncompletePlaybackConfiguration extends Data.TaggedError(
  "MediaTailorIncompletePlaybackConfiguration",
)<{ message: string }> {}

type PlaybackConfigurationAttributes = {
  name: string;
  playbackConfigurationArn: string;
  playbackEndpointPrefix: string;
  sessionInitializationEndpointPrefix: string;
  hlsManifestEndpointPrefix: string | undefined;
  dashManifestEndpointPrefix: string | undefined;
};

export const PlaybackConfigurationProvider = () =>
  Provider.effect(
    PlaybackConfiguration,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<PlaybackConfigurationProps, "name">,
      ) {
        // MediaTailor playback configuration names max out at 64 characters.
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const toAttributes = Effect.fn(function* (
        config: mediatailor.GetPlaybackConfigurationResponse,
      ) {
        if (
          config.Name === undefined ||
          config.PlaybackConfigurationArn === undefined ||
          config.PlaybackEndpointPrefix === undefined ||
          config.SessionInitializationEndpointPrefix === undefined
        ) {
          return yield* new MediaTailorIncompletePlaybackConfiguration({
            message: `playback configuration '${config.Name}' is missing its ARN or endpoint prefixes`,
          });
        }
        return {
          name: config.Name,
          playbackConfigurationArn: config.PlaybackConfigurationArn,
          playbackEndpointPrefix: config.PlaybackEndpointPrefix,
          sessionInitializationEndpointPrefix:
            config.SessionInitializationEndpointPrefix,
          hlsManifestEndpointPrefix:
            config.HlsConfiguration?.ManifestEndpointPrefix,
          dashManifestEndpointPrefix:
            config.DashConfiguration?.ManifestEndpointPrefix,
        } satisfies PlaybackConfigurationAttributes;
      });

      const observe = (name: string) =>
        mediatailor.getPlaybackConfiguration({ Name: name }).pipe(
          Effect.map(
            (
              config,
            ): mediatailor.GetPlaybackConfigurationResponse | undefined =>
              config,
          ),
          // Typed synthetic tag for a missing playback configuration.
          Effect.catchTag("PlaybackConfigurationNotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      const desiredRequest = (
        name: string,
        props: PlaybackConfigurationProps,
      ): mediatailor.PutPlaybackConfigurationRequest => ({
        Name: name,
        AdDecisionServerUrl: props.adDecisionServerUrl,
        VideoContentSourceUrl: props.videoContentSourceUrl,
        SlateAdUrl: props.slateAdUrl,
        PersonalizationThresholdSeconds: toWireSeconds(
          props.personalizationThreshold,
        ),
        TranscodeProfileName: props.transcodeProfileName,
        InsertionMode: props.insertionMode,
        CdnConfiguration: props.cdnConfiguration && {
          AdSegmentUrlPrefix: props.cdnConfiguration.adSegmentUrlPrefix,
          ContentSegmentUrlPrefix:
            props.cdnConfiguration.contentSegmentUrlPrefix,
        },
        DashConfiguration: props.dashConfiguration && {
          MpdLocation: props.dashConfiguration.mpdLocation,
          OriginManifestType: props.dashConfiguration.originManifestType,
        },
        AvailSuppression: props.availSuppression && {
          Mode: props.availSuppression.mode,
          Value: props.availSuppression.value,
          FillPolicy: props.availSuppression.fillPolicy,
        },
        Bumper: props.bumper && {
          StartUrl: props.bumper.startUrl,
          EndUrl: props.bumper.endUrl,
        },
        LivePreRollConfiguration: props.livePreRollConfiguration && {
          AdDecisionServerUrl:
            props.livePreRollConfiguration.adDecisionServerUrl,
          MaxDurationSeconds: toWireSeconds(
            props.livePreRollConfiguration.maxDuration,
          ),
        },
        ManifestProcessingRules: props.manifestProcessingRules && {
          AdMarkerPassthrough: {
            Enabled: props.manifestProcessingRules.adMarkerPassthroughEnabled,
          },
        },
      });

      return PlaybackConfiguration.Provider.of({
        stables: ["name", "playbackConfigurationArn"],
        list: () =>
          Effect.gen(function* () {
            const items = yield* mediatailor.listPlaybackConfigurations
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(items).flatMap((config) =>
              config.Name !== undefined &&
              config.PlaybackConfigurationArn !== undefined &&
              config.PlaybackEndpointPrefix !== undefined &&
              config.SessionInitializationEndpointPrefix !== undefined
                ? [
                    {
                      name: config.Name,
                      playbackConfigurationArn: config.PlaybackConfigurationArn,
                      playbackEndpointPrefix: config.PlaybackEndpointPrefix,
                      sessionInitializationEndpointPrefix:
                        config.SessionInitializationEndpointPrefix,
                      hlsManifestEndpointPrefix:
                        config.HlsConfiguration?.ManifestEndpointPrefix,
                      dashManifestEndpointPrefix:
                        config.DashConfiguration?.ManifestEndpointPrefix,
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const found = yield* observe(name);
          if (found === undefined) return undefined;
          const attrs = yield* toAttributes(found);
          return (yield* hasAlchemyTags(id, tagRecord(found.Tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. ENSURE + SYNC — PutPlaybackConfiguration is a full-replace
          //    upsert: omitted fields are cleared server-side. Because a
          //    prop the user removed must be un-set on the cloud config,
          //    the put is always applied (a subset comparison against the
          //    observed config cannot see removals, and server-side
          //    defaults make full-equality checks fragile). This one call
          //    converges greenfield, update, and adoption identically.
          const put = yield* mediatailor.putPlaybackConfiguration({
            ...desiredRequest(name, news),
            Tags: desiredTags,
          });
          const attrs = yield* toAttributes(put);

          // 2. SYNC LOGS — ConfigureLogsForPlaybackConfiguration is a
          //    separate API; diff the OBSERVED post-put log configuration
          //    against the desired one and only call the API on a delta.
          //    A removed `logConfiguration` prop converges to percent 0
          //    (session logging disabled).
          const desiredLogs = news.logConfiguration;
          const observedLogs = put.LogConfiguration;
          const observedPercent = observedLogs?.PercentEnabled ?? 0;
          const desiredPercent = desiredLogs?.percentEnabled ?? 0;
          const observedStrategies = [
            ...(observedLogs?.EnabledLoggingStrategies ?? []),
          ].sort();
          const desiredStrategies =
            desiredLogs === undefined
              ? observedStrategies // nothing desired: only percent converges
              : [...(desiredLogs.enabledLoggingStrategies ?? [])].sort();
          if (
            observedPercent !== desiredPercent ||
            observedStrategies.join(",") !== desiredStrategies.join(",")
          ) {
            yield* mediatailor.configureLogsForPlaybackConfiguration({
              PlaybackConfigurationName: name,
              PercentEnabled: desiredPercent,
              ...(desiredLogs?.enabledLoggingStrategies
                ? {
                    EnabledLoggingStrategies:
                      desiredLogs.enabledLoggingStrategies,
                  }
                : {}),
            });
          }

          // 3. SYNC TAGS — diff against the OBSERVED post-put tags so
          //    adoption (which can bring foreign tags the put may not
          //    remove) converges.
          const currentTags = tagRecord(put.Tags);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* mediatailor.tagResource({
              ResourceArn: attrs.playbackConfigurationArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* mediatailor.untagResource({
              ResourceArn: attrs.playbackConfigurationArn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // DeletePlaybackConfiguration is idempotent server-side: deleting
          // a configuration that does not exist succeeds with an empty body
          // (verified live), so no not-found handling is required.
          yield* mediatailor.deletePlaybackConfiguration({
            Name: output.name,
          });
        }),
      });
    }),
  );
