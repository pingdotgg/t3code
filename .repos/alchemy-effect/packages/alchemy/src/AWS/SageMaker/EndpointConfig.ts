import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface EndpointConfigProps {
  /**
   * Name of the endpoint configuration. Maximum 63 characters.
   * @default ${app}-${stage}-${id}
   */
  endpointConfigName?: string;
  /**
   * The models to host and the resources (instances or serverless capacity)
   * to deploy each on. At least one variant is required. Use
   * `ServerlessConfig` for pay-per-request serverless inference or
   * `InstanceType` + `InitialInstanceCount` for provisioned instances.
   */
  productionVariants: sagemaker.ProductionVariant[];
  /**
   * Shadow variants that receive a copy of the traffic for testing a new
   * model behind the production variant.
   */
  shadowProductionVariants?: sagemaker.ProductionVariant[];
  /**
   * Capture inference request/response payloads to S3 (for monitoring or
   * retraining).
   */
  dataCaptureConfig?: sagemaker.DataCaptureConfig;
  /**
   * KMS key that SageMaker uses to encrypt data on the storage volume of the
   * hosting instances. Not supported for serverless variants.
   */
  kmsKeyId?: string;
  /**
   * Configure the endpoint for asynchronous inference.
   */
  asyncInferenceConfig?: sagemaker.AsyncInferenceConfig;
  /**
   * SageMaker Clarify explainer configuration.
   */
  explainerConfig?: sagemaker.ExplainerConfig;
  /**
   * IAM role used by the endpoint (when variants require one).
   */
  executionRoleArn?: string;
  /**
   * VPC configuration for the hosted models.
   */
  vpcConfig?: sagemaker.VpcConfig;
  /**
   * Isolate the hosted containers from the network.
   * @default false
   */
  enableNetworkIsolation?: boolean;
  /**
   * Tags to associate with the endpoint configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EndpointConfig extends Resource<
  "AWS.SageMaker.EndpointConfig",
  EndpointConfigProps,
  {
    /**
     * The endpoint configuration's name.
     */
    endpointConfigName: string;
    /**
     * ARN of the endpoint configuration.
     */
    endpointConfigArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SageMaker EndpointConfig — the deployment recipe that maps one
 * or more `Model`s to hosting resources (provisioned instances or serverless
 * capacity). Pure configuration: it costs nothing until an `Endpoint`
 * references it.
 *
 * Endpoint configurations are immutable — any change other than tags
 * replaces the configuration. To roll a live endpoint onto new settings,
 * point the `Endpoint` at the replacement config (alchemy creates the new
 * config first, updates the endpoint, then deletes the old config).
 * @resource
 * @section Creating Endpoint Configurations
 * @example Serverless Variant
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const config = yield* AWS.SageMaker.EndpointConfig("MyConfig", {
 *   productionVariants: [{
 *     VariantName: "AllTraffic",
 *     ModelName: model.modelName,
 *     ServerlessConfig: { MemorySizeInMB: 2048, MaxConcurrency: 5 },
 *   }],
 * });
 * ```
 *
 * @example Provisioned Instances
 * ```typescript
 * const config = yield* AWS.SageMaker.EndpointConfig("MyConfig", {
 *   productionVariants: [{
 *     VariantName: "AllTraffic",
 *     ModelName: model.modelName,
 *     InstanceType: "ml.m5.large",
 *     InitialInstanceCount: 1,
 *   }],
 * });
 * ```
 */
export const EndpointConfig = Resource<EndpointConfig>(
  "AWS.SageMaker.EndpointConfig",
);

const createConfigName = (
  id: string,
  props: { endpointConfigName?: string | undefined },
) =>
  props.endpointConfigName
    ? Effect.succeed(props.endpointConfigName)
    : createPhysicalName({ id, maxLength: 63 });

const fetchConfigTags = Effect.fn(function* (arn: string) {
  const response = yield* sagemaker
    .listTags({ ResourceArn: arn })
    .pipe(
      Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
    );
  return Object.fromEntries(
    (response?.Tags ?? []).flatMap((tag) =>
      tag.Key !== undefined ? [[tag.Key, tag.Value ?? ""]] : [],
    ),
  );
});

const readEndpointConfig = Effect.fn(function* (name: string) {
  const described = yield* sagemaker
    .describeEndpointConfig({ EndpointConfigName: name })
    .pipe(
      Effect.catchTag("EndpointConfigNotFound", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  return {
    endpointConfigName: described.EndpointConfigName,
    endpointConfigArn: described.EndpointConfigArn,
  };
});

export const EndpointConfigProvider = () =>
  Provider.effect(
    EndpointConfig,
    Effect.gen(function* () {
      return {
        stables: ["endpointConfigName", "endpointConfigArn"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listEndpointConfigs
              .pages({})
              .pipe(
                EffectStream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.EndpointConfigs ?? [],
                  ),
                ),
              );
            return summaries.flatMap((s) =>
              s.EndpointConfigName !== undefined &&
              s.EndpointConfigArn !== undefined
                ? [
                    {
                      endpointConfigName: s.EndpointConfigName,
                      endpointConfigArn: s.EndpointConfigArn,
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.endpointConfigName ??
            (yield* createConfigName(id, olds ?? {}));
          const attrs = yield* readEndpointConfig(name);
          if (!attrs) return undefined;
          const tags = yield* fetchConfigTags(attrs.endpointConfigArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // Endpoint configs are immutable — everything except tags replaces.
          const identity = (props: EndpointConfigProps) => [
            props.productionVariants,
            props.shadowProductionVariants,
            props.dataCaptureConfig,
            props.kmsKeyId,
            props.asyncInferenceConfig,
            props.explainerConfig,
            props.executionRoleArn,
            props.vpcConfig,
            props.enableNetworkIsolation ?? false,
          ];
          const oldName = yield* createConfigName(id, olds);
          const newName = yield* createConfigName(id, news);
          if (
            oldName !== newName ||
            JSON.stringify(identity(olds)) !== JSON.stringify(identity(news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker EndpointConfig requires props"),
            );
          }
          const name =
            output?.endpointConfigName ?? (yield* createConfigName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let attrs = yield* readEndpointConfig(name);

          // Ensure — create if missing; tolerate the already-exists race.
          if (attrs === undefined) {
            yield* sagemaker
              .createEndpointConfig({
                EndpointConfigName: name,
                ProductionVariants: news.productionVariants,
                ShadowProductionVariants: news.shadowProductionVariants,
                DataCaptureConfig: news.dataCaptureConfig,
                KmsKeyId: news.kmsKeyId,
                AsyncInferenceConfig: news.asyncInferenceConfig,
                ExplainerConfig: news.explainerConfig,
                ExecutionRoleArn: news.executionRoleArn,
                VpcConfig: news.vpcConfig,
                EnableNetworkIsolation: news.enableNetworkIsolation,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "EndpointConfigAlreadyExists",
                  () => Effect.void,
                ),
              );
            attrs = yield* readEndpointConfig(name);
            if (attrs === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created endpoint config ${name}`),
              );
            }
          }

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchConfigTags(attrs.endpointConfigArn);
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: attrs.endpointConfigArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: attrs.endpointConfigArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(attrs.endpointConfigArn);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sagemaker
            .deleteEndpointConfig({
              EndpointConfigName: output.endpointConfigName,
            })
            .pipe(Effect.catchTag("EndpointConfigNotFound", () => Effect.void));
        }),
      };
    }),
  );
