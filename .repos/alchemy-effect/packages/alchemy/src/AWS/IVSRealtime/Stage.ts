import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  retryWhileThrottled,
  syncIvsRealtimeTags,
  toTagRecord,
} from "./internal.ts";

export interface StageAutoParticipantRecordingConfiguration {
  /**
   * ARN of the IVS Real-Time storage configuration recordings are
   * written to.
   */
  storageConfigurationArn: string;
  /**
   * Types of media to record (`AUDIO_VIDEO`, `AUDIO_ONLY`, or `NONE`).
   * @default ["AUDIO_VIDEO"]
   */
  mediaTypes?: string[];
  /**
   * Reconnect window within which a rejoining participant is recorded into
   * the same file set, e.g. `"2 minutes"` or `Duration.seconds(30)` (`0`
   * disables). The API stores whole seconds.
   * @default 0
   */
  recordingReconnectWindow?: Duration.Input;
  /**
   * Whether participant replicas are also recorded.
   * @default true
   */
  recordParticipantReplicas?: boolean;
}

export interface StageProps {
  /**
   * Name of the stage (letters, digits, `-` and `_`; not unique). If
   * omitted, a deterministic physical name is generated. Stage names are
   * mutable — changing the name updates the stage in place.
   */
  stageName?: string;
  /**
   * Configuration for automatic recording of individual stage
   * participants to an S3 storage configuration.
   * @default no automatic recording
   */
  autoParticipantRecordingConfiguration?: StageAutoParticipantRecordingConfiguration;
  /**
   * Tags to apply to the stage. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Stage extends Resource<
  "AWS.IVSRealtime.Stage",
  StageProps,
  {
    /**
     * The stage's physical name.
     */
    stageName: string;
    /**
     * ARN of the stage.
     */
    stageArn: string;
    /**
     * WHIP ingest endpoint for WebRTC publishers.
     */
    whipEndpoint: string | undefined;
    /**
     * Endpoint delivering stage events.
     */
    eventsEndpoint: string | undefined;
    /**
     * RTMP ingest endpoint for broadcast software.
     */
    rtmpEndpoint: string | undefined;
    /**
     * RTMPS (TLS) ingest endpoint for broadcast software.
     */
    rtmpsEndpoint: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS Real-Time stage — a virtual space where participants
 * exchange audio and video in real time (sub-300ms latency).
 *
 * Participants join a stage with participant tokens minted at runtime via
 * `CreateParticipantToken`; publishers can also ingest via the stage's
 * WHIP/RTMP endpoints.
 * @resource
 * @section Creating Stages
 * @example Basic Stage
 * ```typescript
 * import * as IVSRealtime from "alchemy/AWS/IVSRealtime";
 *
 * const stage = yield* IVSRealtime.Stage("VideoRoom");
 * ```
 *
 * @example Named Stage with Tags
 * ```typescript
 * const stage = yield* IVSRealtime.Stage("VideoRoom", {
 *   stageName: "my-video-room",
 *   tags: { team: "media" },
 * });
 * ```
 */
export const Stage = Resource<Stage>("AWS.IVSRealtime.Stage");

/**
 * Raised when the IVS Real-Time API returns a stage missing its ARN or
 * name.
 */
export class IvsRealtimeStageIncomplete extends Data.TaggedError(
  "IvsRealtimeStageIncomplete",
)<{ message: string }> {}

/**
 * Convert the recording configuration prop shape (Duration-typed reconnect
 * window) to the wire shape the IVS Real-Time API expects (whole seconds).
 */
const toWireRecordingConfig = (
  config: StageAutoParticipantRecordingConfiguration | undefined,
): ivsrealtime.AutoParticipantRecordingConfiguration | undefined =>
  config === undefined
    ? undefined
    : {
        storageConfigurationArn: config.storageConfigurationArn,
        mediaTypes: config.mediaTypes,
        recordingReconnectWindowSeconds: toWireSeconds(
          config.recordingReconnectWindow,
        ),
        recordParticipantReplicas: config.recordParticipantReplicas,
      };

/** Deep-equality on the recording configuration's user-specified fields. */
const recordingConfigDrifted = (
  desired: ivsrealtime.AutoParticipantRecordingConfiguration | undefined,
  observed: ivsrealtime.AutoParticipantRecordingConfiguration | undefined,
): boolean => {
  if (desired === undefined) return false; // unspecified — leave alone
  if (observed === undefined) return true;
  if (desired.storageConfigurationArn !== observed.storageConfigurationArn) {
    return true;
  }
  if (
    desired.mediaTypes !== undefined &&
    JSON.stringify(desired.mediaTypes) !== JSON.stringify(observed.mediaTypes)
  ) {
    return true;
  }
  if (
    desired.recordingReconnectWindowSeconds !== undefined &&
    desired.recordingReconnectWindowSeconds !==
      observed.recordingReconnectWindowSeconds
  ) {
    return true;
  }
  if (
    desired.recordParticipantReplicas !== undefined &&
    desired.recordParticipantReplicas !== observed.recordParticipantReplicas
  ) {
    return true;
  }
  return false;
};

export const StageProvider = () =>
  Provider.effect(
    Stage,
    Effect.gen(function* () {
      const toName = (id: string, props: StageProps) =>
        props.stageName
          ? Effect.succeed(props.stageName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = Effect.fn(function* (stage: ivsrealtime.Stage) {
        if (!stage.name) {
          return yield* Effect.fail(
            new IvsRealtimeStageIncomplete({
              message: "IVS Real-Time stage is missing its name",
            }),
          );
        }
        return {
          stageName: stage.name,
          stageArn: stage.arn,
          whipEndpoint: stage.endpoints?.whip,
          eventsEndpoint: stage.endpoints?.events,
          rtmpEndpoint: stage.endpoints?.rtmp,
          rtmpsEndpoint: stage.endpoints?.rtmps,
        };
      });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* ivsrealtime.getStage({ arn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        return response?.stage;
      });

      /**
       * ListStages has no name filter — enumerate and match exactly.
       * Only used when the output ARN cache is unavailable.
       */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivsrealtime.listStages.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.stages),
          ),
          retryWhileThrottled,
        );
        const match = summaries.find((s) => s.name === name);
        return match === undefined ? undefined : yield* getByArn(match.arn);
      });

      return {
        stables: ["stageArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const stage = output?.stageArn
            ? yield* getByArn(output.stageArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (stage === undefined) return undefined;
          const attrs = yield* toAttrs(stage);
          return (yield* hasAlchemyTags(id, toTagRecord(stage.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredRecording = toWireRecordingConfig(
            news.autoParticipantRecordingConfiguration,
          );

          // 1. Observe.
          let observed = output?.stageArn
            ? yield* getByArn(output.stageArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            const created = yield* ivsrealtime
              .createStage({
                name,
                autoParticipantRecordingConfiguration: desiredRecording,
                tags: desiredTags,
              })
              .pipe(retryWhileThrottled);
            observed = created.stage;
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new IvsRealtimeStageIncomplete({
                message: "IVS Real-Time CreateStage returned no stage",
              }),
            );
          }
          const arn = observed.arn;

          // 3. Sync — name and recording configuration are mutable via
          // UpdateStage; apply only on drift.
          const patch: Partial<ivsrealtime.UpdateStageRequest> = {};
          if (observed.name !== name) patch.name = name;
          if (
            recordingConfigDrifted(
              desiredRecording,
              observed.autoParticipantRecordingConfiguration,
            )
          ) {
            patch.autoParticipantRecordingConfiguration = desiredRecording;
          }
          if (Object.keys(patch).length > 0) {
            yield* ivsrealtime
              .updateStage({ arn, ...patch })
              .pipe(retryWhileThrottled, retryWhileConflict);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncIvsRealtimeTags(arn, desiredTags);

          // 4. Return fresh attributes.
          const final = yield* getByArn(arn);
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsRealtimeStageIncomplete({
                message: `IVS Real-Time stage '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting a stage with an active session raises
          // ConflictException — retry through a bounded window.
          yield* ivsrealtime.deleteStage({ arn: output.stageArn }).pipe(
            retryWhileThrottled,
            retryWhileConflict,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),

        list: () =>
          ivsrealtime.listStages.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.stages),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  getByArn(summary.arn).pipe(
                    Effect.flatMap((stage) =>
                      stage === undefined
                        ? Effect.succeed(undefined)
                        : toAttrs(stage),
                    ),
                  ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
