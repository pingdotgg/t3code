import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface RecordingGroupProps {
  /**
   * Record every supported (regional) resource type. Mutually exclusive
   * with `resourceTypes`.
   * @default false
   */
  allSupported?: boolean;
  /**
   * Also record global resource types (e.g. IAM). Only meaningful with
   * `allSupported: true`.
   * @default false
   */
  includeGlobalResourceTypes?: boolean;
  /**
   * The specific resource types to record, e.g. `AWS::S3::Bucket`. Only
   * meaningful when `allSupported` is `false`.
   */
  resourceTypes?: string[];
  /**
   * Resource types to exclude from recording. Requires
   * `recordingStrategy.useOnly: "EXCLUSION_BY_RESOURCE_TYPES"`.
   */
  exclusionByResourceTypes?: {
    /**
     * The resource types excluded from recording.
     */
    resourceTypes: string[];
  };
  /**
   * Which recording strategy the recorder uses.
   */
  recordingStrategy?: {
    /**
     * `ALL_SUPPORTED_RESOURCE_TYPES`, `INCLUSION_BY_RESOURCE_TYPES`, or
     * `EXCLUSION_BY_RESOURCE_TYPES`.
     */
    useOnly?:
      | "ALL_SUPPORTED_RESOURCE_TYPES"
      | "INCLUSION_BY_RESOURCE_TYPES"
      | "EXCLUSION_BY_RESOURCE_TYPES";
  };
}

export interface RecordingModeProps {
  /**
   * The default recording frequency for all recorded resource types.
   */
  recordingFrequency: "CONTINUOUS" | "DAILY";
  /**
   * Per-resource-type overrides of the recording frequency.
   */
  recordingModeOverrides?: {
    /**
     * Description of the override.
     */
    description?: string;
    /**
     * The resource types the override applies to.
     */
    resourceTypes: string[];
    /**
     * The recording frequency for the overridden resource types.
     */
    recordingFrequency: "CONTINUOUS" | "DAILY";
  }[];
}

export interface ConfigurationRecorderProps {
  /**
   * Name of the configuration recorder. AWS allows only ONE customer
   * managed configuration recorder per account per region. Changing the
   * name replaces the recorder.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * ARN of the IAM role the recorder assumes to read your resources'
   * configurations, e.g. the `AWSServiceRoleForConfig` service-linked role
   * (`arn:aws:iam::{account}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`).
   */
  roleArn: string;
  /**
   * Which resource types the recorder records.
   * @default all supported resource types
   */
  recordingGroup?: RecordingGroupProps;
  /**
   * How frequently the recorder records configuration changes.
   * @default CONTINUOUS
   */
  recordingMode?: RecordingModeProps;
  /**
   * Desired recording state. `true` starts the recorder (requires a
   * delivery channel), `false` stops it. When omitted the recording state
   * is left untouched.
   */
  recording?: boolean;
  /**
   * Tags to apply to the recorder. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationRecorder extends Resource<
  "AWS.Config.ConfigurationRecorder",
  ConfigurationRecorderProps,
  {
    /** Physical name of the configuration recorder. */
    recorderName: string;
    /** ARN of the configuration recorder. */
    recorderArn: string;
  },
  never,
  Providers
> {}

/**
 * The AWS Config configuration recorder that detects and records changes to
 * your AWS resource configurations.
 *
 * AWS allows only **one** customer managed configuration recorder per
 * account per region — treat this resource as an account-region singleton.
 * Starting the recorder (`recording: true`) requires a delivery channel
 * (see `AWS.Config.DeliveryChannel`) and incurs per-configuration-item
 * charges.
 * @resource
 * @section Creating the Recorder
 * @example Recorder with the Config service-linked role
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const recorder = yield* Config.ConfigurationRecorder("Recorder", {
 *   roleArn: `arn:aws:iam::${accountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
 *   recordingGroup: { allSupported: true },
 * });
 * ```
 *
 * @example Record only specific resource types
 * ```typescript
 * const recorder = yield* Config.ConfigurationRecorder("Recorder", {
 *   roleArn: serviceLinkedRoleArn,
 *   recordingGroup: {
 *     resourceTypes: ["AWS::S3::Bucket", "AWS::EC2::SecurityGroup"],
 *   },
 * });
 * ```
 *
 * @section Recording State
 * @example Start recording (requires a delivery channel)
 * ```typescript
 * const channel = yield* Config.DeliveryChannel("Channel", {
 *   s3BucketName: bucket.bucketName,
 * });
 * const recorder = yield* Config.ConfigurationRecorder("Recorder", {
 *   roleArn: serviceLinkedRoleArn,
 *   recording: true,
 * });
 * ```
 */
export const ConfigurationRecorder = Resource<ConfigurationRecorder>(
  "AWS.Config.ConfigurationRecorder",
);

/**
 * A recorder role that was just created can be transiently rejected with
 * `InvalidRoleException` until IAM propagates. Bounded retry (~40s).
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryWhileInvalidRole = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidRoleException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

export const ConfigurationRecorderProvider = () =>
  Provider.effect(
    ConfigurationRecorder,
    Effect.gen(function* () {
      const createRecorderName = Effect.fn(function* (
        id: string,
        props: Pick<ConfigurationRecorderProps, "name">,
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const toWireRecordingGroup = (
        group: RecordingGroupProps | undefined,
      ): config.RecordingGroup | undefined =>
        group === undefined
          ? undefined
          : {
              allSupported: group.allSupported,
              includeGlobalResourceTypes: group.includeGlobalResourceTypes,
              resourceTypes: group.resourceTypes,
              exclusionByResourceTypes: group.exclusionByResourceTypes,
              recordingStrategy: group.recordingStrategy,
            };

      const toWireRecordingMode = (
        mode: RecordingModeProps | undefined,
      ): config.RecordingMode | undefined =>
        mode === undefined
          ? undefined
          : {
              recordingFrequency: mode.recordingFrequency,
              recordingModeOverrides: mode.recordingModeOverrides,
            };

      const observeRecorder = Effect.fn(function* (name: string) {
        const response = yield* config
          .describeConfigurationRecorders({
            ConfigurationRecorderNames: [name],
          })
          .pipe(
            Effect.catchTag("NoSuchConfigurationRecorderException", () =>
              Effect.succeed({ ConfigurationRecorders: [] }),
            ),
          );
        return (response.ConfigurationRecorders ?? []).at(0);
      });

      const observedTags = (arn: string) =>
        config.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.Tags ?? []).flatMap((t) =>
                t.Key !== undefined ? [[t.Key, t.Value ?? ""]] : [],
              ),
            ),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      return ConfigurationRecorder.Provider.of({
        stables: ["recorderName", "recorderArn"],
        list: () =>
          config.describeConfigurationRecorders({}).pipe(
            Effect.map((response) =>
              (response.ConfigurationRecorders ?? []).flatMap((recorder) =>
                recorder.name && recorder.arn
                  ? [
                      {
                        recorderName: recorder.name,
                        recorderArn: recorder.arn,
                      },
                    ]
                  : [],
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.recorderName ?? (yield* createRecorderName(id, olds ?? {}));
          const recorder = yield* observeRecorder(name);
          if (recorder?.arn === undefined) return undefined;
          const attrs = { recorderName: name, recorderArn: recorder.arn };
          const tags = yield* observedTags(recorder.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createRecorderName(id, olds ?? {});
          const newName = yield* createRecorderName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.recorderName ?? (yield* createRecorderName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredGroup = toWireRecordingGroup(news.recordingGroup);
          const desiredMode = toWireRecordingMode(news.recordingMode);

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* observeRecorder(name);

          // 2+3. ENSURE + SYNC — PutConfigurationRecorder is a full upsert;
          //    apply when missing or when a user-declared aspect drifted
          //    (fields AWS defaults are only compared when declared).
          const inSync =
            observed !== undefined &&
            observed.roleARN === news.roleArn &&
            (desiredGroup === undefined ||
              JSON.stringify(observed.recordingGroup) ===
                JSON.stringify({
                  ...observed.recordingGroup,
                  ...desiredGroup,
                })) &&
            (desiredMode === undefined ||
              JSON.stringify(observed.recordingMode) ===
                JSON.stringify({ ...observed.recordingMode, ...desiredMode }));
          if (!inSync) {
            yield* retryWhileInvalidRole(
              config.putConfigurationRecorder({
                ConfigurationRecorder: {
                  name,
                  roleARN: news.roleArn,
                  recordingGroup: desiredGroup,
                  recordingMode: desiredMode,
                },
                Tags: createTagsList(desiredTags),
              }),
            );
          }

          // Re-observe for the ARN (Put returns an empty body).
          const live = yield* observeRecorder(name);
          const recorderArn = live?.arn ?? output?.recorderArn;

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          if (recorderArn !== undefined) {
            const currentTags = yield* observedTags(recorderArn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* config.tagResource({
                ResourceArn: recorderArn,
                Tags: upsert,
              });
            }
            if (removed.length > 0) {
              yield* config.untagResource({
                ResourceArn: recorderArn,
                TagKeys: removed,
              });
            }
          }

          // 3c. SYNC RECORDING STATE — only when the user declared a desired
          //     state; diff against the OBSERVED status.
          if (news.recording !== undefined) {
            const status = yield* config
              .describeConfigurationRecorderStatus({
                ConfigurationRecorderNames: [name],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    (r.ConfigurationRecordersStatus ?? []).at(0)?.recording ??
                    false,
                ),
                Effect.catchTag("NoSuchConfigurationRecorderException", () =>
                  Effect.succeed(false),
                ),
              );
            if (news.recording && !status) {
              yield* config.startConfigurationRecorder({
                ConfigurationRecorderName: name,
              });
            } else if (!news.recording && status) {
              yield* config.stopConfigurationRecorder({
                ConfigurationRecorderName: name,
              });
            }
          }

          yield* session.note(name);
          return { recorderName: name, recorderArn: recorderArn! };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A recorder must be stopped before it can be deleted; both calls
          // treat an already-gone recorder as success.
          yield* config
            .stopConfigurationRecorder({
              ConfigurationRecorderName: output.recorderName,
            })
            .pipe(
              Effect.catchTag(
                "NoSuchConfigurationRecorderException",
                () => Effect.void,
              ),
            );
          yield* config
            .deleteConfigurationRecorder({
              ConfigurationRecorderName: output.recorderName,
            })
            .pipe(
              Effect.catchTag(
                "NoSuchConfigurationRecorderException",
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
