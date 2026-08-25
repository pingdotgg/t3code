import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  listAllChannelGroups,
  listChannelEndpoints,
  listGroupChannels,
  matchesDesired,
  policiesEqual,
  retryWhileMpConflict,
  syncMpTags,
  toMpTagRecord,
} from "./internal.ts";

export interface OriginEndpointProps {
  /**
   * Name of the channel group the endpoint belongs to. Changing it replaces
   * the endpoint.
   */
  channelGroupName: string;
  /**
   * Name of the channel the endpoint packages content from. Changing it
   * replaces the endpoint.
   */
  channelName: string;
  /**
   * Name of the origin endpoint. Must be unique within the channel and match
   * `^[a-zA-Z0-9_-]+$`. If omitted, a unique name is generated. Changing the
   * name replaces the endpoint.
   */
  originEndpointName?: string;
  /**
   * The container format packaged for the endpoint's manifests: `TS`,
   * `CMAF`, or `ISM`. Immutable — changing it replaces the endpoint.
   */
  containerType: mediapackagev2.ContainerType;
  /**
   * Segment settings: duration, name, SCTE-35 ad-marker filtering, and DRM
   * encryption (SPEKE key provider).
   */
  segment?: mediapackagev2.Segment;
  /**
   * Optional description of the origin endpoint (up to 1024 characters).
   */
  description?: string;
  /**
   * The size of the window (1 minute - 14 days, e.g. `"1 hour"` or
   * `Duration.hours(1)`) from which viewers can start over or catch up on
   * previously streamed content. Sent to the API in whole seconds.
   */
  startoverWindow?: Duration.Input;
  /**
   * HLS manifest configurations served by the endpoint.
   */
  hlsManifests?: mediapackagev2.CreateHlsManifestConfiguration[];
  /**
   * Low-latency HLS manifest configurations served by the endpoint.
   */
  lowLatencyHlsManifests?: mediapackagev2.CreateLowLatencyHlsManifestConfiguration[];
  /**
   * DASH manifest configurations served by the endpoint.
   */
  dashManifests?: mediapackagev2.CreateDashManifestConfiguration[];
  /**
   * Microsoft Smooth Streaming (MSS) manifest configurations served by the
   * endpoint. Requires the `ISM` container type.
   */
  mssManifests?: mediapackagev2.CreateMssManifestConfiguration[];
  /**
   * Conditions (stale manifest, missing DRM key, ...) under which the
   * endpoint deliberately serves errors, for testing player behavior.
   */
  forceEndpointErrorConfiguration?: mediapackagev2.ForceEndpointErrorConfiguration;
  /**
   * The separator (`UNDERSCORE` or `HYPHEN`) inserted into manifest and
   * segment URIs.
   */
  uriSeparator?: mediapackagev2.UriSeparator;
  /**
   * IAM resource policy (JSON) attached to the origin endpoint, controlling
   * which principals may retrieve content from it
   * (`mediapackagev2:GetObject` / `mediapackagev2:GetHeadObject`). Omitting
   * it removes any existing policy.
   */
  policy?: string;
  /**
   * CDN authorization for the endpoint policy: the Secrets Manager secrets
   * holding the CDN identifier and the role MediaPackage assumes to read
   * them. Only applied together with {@link OriginEndpointProps.policy}.
   */
  cdnAuthConfiguration?: mediapackagev2.CdnAuthConfiguration;
  /**
   * User-defined tags for the origin endpoint. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

interface ManifestRef {
  /** Name of the manifest. */
  manifestName: string;
  /** Playback URL of the manifest on the group's egress domain. */
  url: string;
}

export interface OriginEndpoint extends Resource<
  "AWS.MediaPackageV2.OriginEndpoint",
  OriginEndpointProps,
  {
    /** Name of the channel group the endpoint belongs to. */
    channelGroupName: string;
    /** Name of the channel the endpoint packages content from. */
    channelName: string;
    /** Name of the origin endpoint. */
    originEndpointName: string;
    /** ARN of the origin endpoint. */
    originEndpointArn: string;
    /** Output container type (`TS`, `CMAF`, or `ISM`). */
    containerType: string;
    /** HLS manifests served by the endpoint. */
    hlsManifests: ManifestRef[];
    /** Low-latency HLS manifests served by the endpoint. */
    lowLatencyHlsManifests: ManifestRef[];
    /** DASH manifests served by the endpoint. */
    dashManifests: ManifestRef[];
    /** Microsoft Smooth Streaming manifests served by the endpoint. */
    mssManifests: ManifestRef[];
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaPackage v2 origin endpoint — the output side of a
 * channel. The endpoint packages the channel's ingested content into HLS,
 * low-latency HLS, DASH, and/or MSS manifests and serves them to downstream
 * devices (players or CDNs) on the channel group's egress domain.
 *
 * @resource
 * @section Creating an Origin Endpoint
 * @example HLS Endpoint on a Channel
 * ```typescript
 * import * as MediaPackageV2 from "alchemy/AWS/MediaPackageV2";
 *
 * const group = yield* MediaPackageV2.ChannelGroup("Live");
 * const channel = yield* MediaPackageV2.Channel("Feed", {
 *   channelGroupName: group.channelGroupName,
 * });
 * const endpoint = yield* MediaPackageV2.OriginEndpoint("Playback", {
 *   channelGroupName: group.channelGroupName,
 *   channelName: channel.channelName,
 *   containerType: "TS",
 *   hlsManifests: [{ ManifestName: "index" }],
 * });
 * ```
 *
 * @example CMAF Endpoint with DASH and Low-Latency HLS
 * ```typescript
 * const endpoint = yield* MediaPackageV2.OriginEndpoint("Playback", {
 *   channelGroupName: group.channelGroupName,
 *   channelName: channel.channelName,
 *   containerType: "CMAF",
 *   segment: { SegmentDurationSeconds: 4 },
 *   dashManifests: [{ ManifestName: "dash" }],
 *   lowLatencyHlsManifests: [{ ManifestName: "ll-hls" }],
 * });
 * ```
 *
 * @section Startover Window
 * @example Allow viewers to catch up on the last hour
 * ```typescript
 * const endpoint = yield* MediaPackageV2.OriginEndpoint("Playback", {
 *   channelGroupName: group.channelGroupName,
 *   channelName: channel.channelName,
 *   containerType: "TS",
 *   startoverWindow: "1 hour",
 *   hlsManifests: [{ ManifestName: "index" }],
 * });
 * ```
 *
 * @section Resource Policy
 * @example Restrict playback to a CDN principal
 * ```typescript
 * const endpoint = yield* MediaPackageV2.OriginEndpoint("Playback", {
 *   channelGroupName: group.channelGroupName,
 *   channelName: channel.channelName,
 *   containerType: "TS",
 *   hlsManifests: [{ ManifestName: "index" }],
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *       Action: ["mediapackagev2:GetObject", "mediapackagev2:GetHeadObject"],
 *       Resource: "arn:aws:mediapackagev2:us-east-1:111122223333:channelGroup/live/channel/feed/originEndpoint/playback",
 *     }],
 *   }),
 * });
 * ```
 *
 * @section Playback URLs
 * @example Read the served manifest URLs
 * ```typescript
 * const playbackUrl = endpoint.hlsManifests.map((m) => m.url);
 * ```
 */
export const OriginEndpoint = Resource<OriginEndpoint>(
  "AWS.MediaPackageV2.OriginEndpoint",
);

export const OriginEndpointProvider = () =>
  Provider.effect(
    OriginEndpoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { originEndpointName?: string },
      ) {
        return (
          props.originEndpointName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const manifestRefs = (
        manifests: { ManifestName: string; Url: string }[] | undefined,
      ): ManifestRef[] =>
        (manifests ?? []).map((m) => ({
          manifestName: m.ManifestName,
          url: m.Url,
        }));

      const toAttrs = (endpoint: {
        Arn: string;
        ChannelGroupName: string;
        ChannelName: string;
        OriginEndpointName: string;
        ContainerType: mediapackagev2.ContainerType;
        HlsManifests?: mediapackagev2.GetHlsManifestConfiguration[];
        LowLatencyHlsManifests?: mediapackagev2.GetLowLatencyHlsManifestConfiguration[];
        DashManifests?: mediapackagev2.GetDashManifestConfiguration[];
        MssManifests?: mediapackagev2.GetMssManifestConfiguration[];
      }) => ({
        channelGroupName: endpoint.ChannelGroupName,
        channelName: endpoint.ChannelName,
        originEndpointName: endpoint.OriginEndpointName,
        originEndpointArn: endpoint.Arn,
        containerType: endpoint.ContainerType,
        hlsManifests: manifestRefs(endpoint.HlsManifests),
        lowLatencyHlsManifests: manifestRefs(endpoint.LowLatencyHlsManifests),
        dashManifests: manifestRefs(endpoint.DashManifests),
        mssManifests: manifestRefs(endpoint.MssManifests),
      });

      /** Get an origin endpoint; typed not-found → undefined. */
      const getEndpoint = Effect.fn(function* (
        channelGroupName: string,
        channelName: string,
        originEndpointName: string,
      ) {
        return yield* mediapackagev2
          .getOriginEndpoint({
            ChannelGroupName: channelGroupName,
            ChannelName: channelName,
            OriginEndpointName: originEndpointName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: [
          "channelGroupName",
          "channelName",
          "originEndpointName",
          "originEndpointArn",
          "containerType",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          // Group, channel, name, and container type are the endpoint's
          // identity.
          if (olds.channelGroupName !== news.channelGroupName) {
            return { action: "replace" } as const;
          }
          if (olds.channelName !== news.channelName) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (olds.containerType !== news.containerType) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const channelGroupName =
            output?.channelGroupName ?? olds?.channelGroupName;
          const channelName = output?.channelName ?? olds?.channelName;
          if (channelGroupName === undefined || channelName === undefined) {
            return undefined;
          }
          const name =
            output?.originEndpointName ?? (yield* createName(id, olds ?? {}));
          const endpoint = yield* getEndpoint(
            channelGroupName,
            channelName,
            name,
          );
          if (endpoint === undefined) return undefined;
          const attrs = toAttrs(endpoint);
          return (yield* hasAlchemyTags(id, toMpTagRecord(endpoint.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const channelGroupName = news.channelGroupName;
          const channelName = news.channelName;
          // The wire field is whole seconds.
          const startoverWindowSeconds = toWireSeconds(news.startoverWindow);
          const name =
            output?.originEndpointName ?? (yield* createName(id, news));

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let endpoint = yield* getEndpoint(
            channelGroupName,
            channelName,
            name,
          );

          // 2. Ensure — create if missing; a Conflict means a peer created it
          //    concurrently, so fall through to observing the winner.
          if (endpoint === undefined) {
            endpoint = yield* mediapackagev2
              .createOriginEndpoint({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                OriginEndpointName: name,
                ContainerType: news.containerType,
                Segment: news.segment,
                Description: news.description,
                StartoverWindowSeconds: startoverWindowSeconds,
                HlsManifests: news.hlsManifests,
                LowLatencyHlsManifests: news.lowLatencyHlsManifests,
                DashManifests: news.dashManifests,
                MssManifests: news.mssManifests,
                ForceEndpointErrorConfiguration:
                  news.forceEndpointErrorConfiguration,
                UriSeparator: news.uriSeparator,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  mediapackagev2.getOriginEndpoint({
                    ChannelGroupName: channelGroupName,
                    ChannelName: channelName,
                    OriginEndpointName: name,
                  }),
                ),
              );
          } else {
            // 3. Sync — the update is a full PUT of the mutable aspects, so
            //    apply it only when the observed state has drifted from the
            //    desired subset. Manifest arrays are compared by length and
            //    by the fields the desired config specifies, so server-side
            //    defaults never register as drift.
            const desired = {
              Segment: news.segment,
              Description: news.description ?? "",
              StartoverWindowSeconds: startoverWindowSeconds,
              HlsManifests: news.hlsManifests ?? [],
              LowLatencyHlsManifests: news.lowLatencyHlsManifests ?? [],
              DashManifests: news.dashManifests ?? [],
              MssManifests: news.mssManifests ?? [],
              ForceEndpointErrorConfiguration:
                news.forceEndpointErrorConfiguration,
              UriSeparator: news.uriSeparator,
            };
            const observed = {
              Segment: endpoint.Segment,
              Description: endpoint.Description ?? "",
              StartoverWindowSeconds: endpoint.StartoverWindowSeconds,
              HlsManifests: endpoint.HlsManifests ?? [],
              LowLatencyHlsManifests: endpoint.LowLatencyHlsManifests ?? [],
              DashManifests: endpoint.DashManifests ?? [],
              MssManifests: endpoint.MssManifests ?? [],
              ForceEndpointErrorConfiguration:
                endpoint.ForceEndpointErrorConfiguration,
              UriSeparator: endpoint.UriSeparator,
            };
            if (!matchesDesired(desired, observed)) {
              endpoint = yield* mediapackagev2.updateOriginEndpoint({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                OriginEndpointName: name,
                ContainerType: news.containerType,
                Segment: news.segment,
                Description: news.description,
                StartoverWindowSeconds: startoverWindowSeconds,
                HlsManifests: news.hlsManifests,
                LowLatencyHlsManifests: news.lowLatencyHlsManifests,
                DashManifests: news.dashManifests,
                MssManifests: news.mssManifests,
                ForceEndpointErrorConfiguration:
                  news.forceEndpointErrorConfiguration,
                UriSeparator: news.uriSeparator,
              });
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMpTags(
            endpoint.Arn,
            toMpTagRecord(endpoint.Tags),
            desiredTags,
          );

          // 3c. Sync the resource policy — observe the live policy (absent
          //     policy is the typed not-found) and apply only the delta.
          const observedPolicy = yield* mediapackagev2
            .getOriginEndpointPolicy({
              ChannelGroupName: channelGroupName,
              ChannelName: channelName,
              OriginEndpointName: name,
            })
            .pipe(
              Effect.map((response) => ({
                policy: response.Policy as string | undefined,
                cdnAuth: response.CdnAuthConfiguration,
              })),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({
                  policy: undefined as string | undefined,
                  cdnAuth: undefined as
                    | mediapackagev2.CdnAuthConfiguration
                    | undefined,
                }),
              ),
            );
          if (news.policy !== undefined) {
            const cdnDrift =
              news.cdnAuthConfiguration === undefined
                ? observedPolicy.cdnAuth !== undefined
                : !matchesDesired(
                    news.cdnAuthConfiguration,
                    observedPolicy.cdnAuth,
                  );
            if (
              !policiesEqual(observedPolicy.policy, news.policy) ||
              cdnDrift
            ) {
              yield* mediapackagev2.putOriginEndpointPolicy({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                OriginEndpointName: name,
                Policy: news.policy,
                CdnAuthConfiguration: news.cdnAuthConfiguration,
              });
            }
          } else if (observedPolicy.policy !== undefined) {
            yield* mediapackagev2.deleteOriginEndpointPolicy({
              ChannelGroupName: channelGroupName,
              ChannelName: channelName,
              OriginEndpointName: name,
            });
          }

          yield* session.note(name);
          return toAttrs(endpoint);
        }),

        delete: Effect.fn(function* ({ output }) {
          // MediaPackage v2 deletes are idempotent (deleting a missing
          // endpoint succeeds); a Conflict from a concurrent mutation is
          // transient.
          yield* mediapackagev2
            .deleteOriginEndpoint({
              ChannelGroupName: output.channelGroupName,
              ChannelName: output.channelName,
              OriginEndpointName: output.originEndpointName,
            })
            .pipe(retryWhileMpConflict);
        }),

        // Origin endpoints are keyed by their parent channel, so enumerate
        // groups → channels → endpoints.
        list: () =>
          Effect.gen(function* () {
            const groups = yield* listAllChannelGroups();
            const channels = yield* Effect.forEach(
              groups,
              (group) => listGroupChannels(group.ChannelGroupName),
              { concurrency: 5 },
            ).pipe(Effect.map((nested) => nested.flat()));
            const items = yield* Effect.forEach(
              channels,
              (channel) =>
                listChannelEndpoints(
                  channel.ChannelGroupName,
                  channel.ChannelName,
                ),
              { concurrency: 5 },
            ).pipe(Effect.map((nested) => nested.flat()));
            // Hydrate each item via get so the attributes carry the manifest
            // URLs; an endpoint can vanish between enumeration and hydration.
            const endpoints = yield* Effect.forEach(
              items,
              (item) =>
                getEndpoint(
                  item.ChannelGroupName,
                  item.ChannelName,
                  item.OriginEndpointName,
                ).pipe(
                  Effect.map((endpoint) =>
                    endpoint === undefined ? undefined : toAttrs(endpoint),
                  ),
                ),
              { concurrency: 5 },
            );
            return endpoints.filter(
              (endpoint): endpoint is OriginEndpoint["Attributes"] =>
                endpoint !== undefined,
            );
          }),
      };
    }),
  );
