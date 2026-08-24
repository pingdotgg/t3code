import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

export type EndpointStatus = sagemaker.EndpointStatus;

export interface EndpointProps {
  /**
   * Name of the endpoint. Maximum 63 characters.
   * @default ${app}-${stage}-${id}
   */
  endpointName?: string;
  /**
   * Name of the `EndpointConfig` that describes the models and hosting
   * resources to deploy. Changing it updates the live endpoint in place
   * (blue/green by default on the SageMaker side).
   */
  endpointConfigName: string;
  /**
   * Deployment (blue/green or rolling) configuration applied when the
   * endpoint is updated to a new configuration.
   */
  deploymentConfig?: sagemaker.DeploymentConfig;
  /**
   * Tags to associate with the endpoint. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Endpoint extends Resource<
  "AWS.SageMaker.Endpoint",
  EndpointProps,
  {
    /**
     * The endpoint's name.
     */
    endpointName: string;
    /**
     * ARN of the endpoint.
     */
    endpointArn: string;
    /**
     * Lifecycle status of the endpoint after reconcile (`InService`).
     */
    endpointStatus: EndpointStatus | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon SageMaker Endpoint — the live, invocable deployment of an
 * `EndpointConfig`. Provisioning takes minutes and **bills while the
 * endpoint exists** (serverless variants bill per request; instance variants
 * bill per instance-hour). Destroy endpoints promptly.
 *
 * Invoke a deployed endpoint from a function with
 * `AWS.SageMakerRuntime.InvokeEndpoint`.
 * @resource
 * @section Creating Endpoints
 * @example Deploy an EndpointConfig
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const endpoint = yield* AWS.SageMaker.Endpoint("MyEndpoint", {
 *   endpointConfigName: config.endpointConfigName,
 * });
 * ```
 *
 * @section Invoking
 * @example Invoke from a Lambda function
 * ```typescript
 * // init
 * const invoke = yield* AWS.SageMakerRuntime.InvokeEndpoint(
 *   endpoint.endpointName,
 * );
 *
 * // runtime
 * const result = yield* invoke({
 *   ContentType: "application/json",
 *   Body: JSON.stringify({ instances: [[1, 2, 3, 4]] }),
 * });
 * ```
 */
export const Endpoint = Resource<Endpoint>("AWS.SageMaker.Endpoint");

const createEndpointName = (
  id: string,
  props: { endpointName?: string | undefined },
) =>
  props.endpointName
    ? Effect.succeed(props.endpointName)
    : createPhysicalName({ id, maxLength: 63 });

const fetchEndpointTags = Effect.fn(function* (arn: string) {
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

const describeEndpointOrUndefined = (name: string) =>
  sagemaker
    .describeEndpoint({ EndpointName: name })
    .pipe(Effect.catchTag("EndpointNotFound", () => Effect.succeed(undefined)));

/**
 * The endpoint is still transitioning toward the awaited state — retried by
 * the bounded wait schedule.
 */
class EndpointNotReady extends Data.TaggedError("EndpointNotReady")<{
  readonly endpointName: string;
  readonly status: string | undefined;
}> {}

/**
 * The endpoint's asynchronous provisioning converged to the terminal
 * `Failed` status (e.g. the container image could not be pulled or the model
 * server failed its health checks).
 */
export class EndpointProvisioningFailed extends Data.TaggedError(
  "EndpointProvisioningFailed",
)<{
  readonly endpointName: string;
  readonly message: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "EndpointNotReady",
    // Endpoint provisioning takes ~3-10 min; poll every 15s up to ~20 min.
    schedule: Schedule.max([
      Schedule.spaced("15 seconds"),
      Schedule.recurs(80),
    ]),
  });

const waitForEndpoint = (name: string, target: "InService" | "Gone") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* describeEndpointOrUndefined(name);
      if (target === "Gone") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new EndpointNotReady({
            endpointName: name,
            status: described.EndpointStatus,
          }),
        );
      }
      if (described?.EndpointStatus === "InService") return;
      if (described?.EndpointStatus === "Failed") {
        return yield* Effect.fail(
          new EndpointProvisioningFailed({
            endpointName: name,
            message: described.FailureReason,
          }),
        );
      }
      return yield* Effect.fail(
        new EndpointNotReady({
          endpointName: name,
          status: described?.EndpointStatus,
        }),
      );
    }),
  );

export const EndpointProvider = () =>
  Provider.effect(
    Endpoint,
    Effect.gen(function* () {
      return {
        stables: ["endpointName", "endpointArn"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listEndpoints.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Endpoints ?? []),
              ),
            );
            return summaries.flatMap((s) =>
              s.EndpointName !== undefined && s.EndpointArn !== undefined
                ? [
                    {
                      endpointName: s.EndpointName,
                      endpointArn: s.EndpointArn,
                      endpointStatus: s.EndpointStatus,
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.endpointName ?? (yield* createEndpointName(id, olds ?? {}));
          const described = yield* describeEndpointOrUndefined(name);
          if (!described || described.EndpointStatus === "Deleting") {
            return undefined;
          }
          const attrs = {
            endpointName: described.EndpointName,
            endpointArn: described.EndpointArn,
            endpointStatus: described.EndpointStatus,
          };
          const tags = yield* fetchEndpointTags(described.EndpointArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createEndpointName(id, olds);
          const newName = yield* createEndpointName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // endpointConfigName changes update the live endpoint in place.
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker Endpoint requires props"),
            );
          }
          const name =
            output?.endpointName ?? (yield* createEndpointName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let described = yield* describeEndpointOrUndefined(name);

          // A terminally-failed endpoint cannot be updated — delete it and
          // fall through to a fresh create so the reconciler converges.
          if (described?.EndpointStatus === "Failed") {
            yield* session.note(
              `Endpoint ${name} is Failed (${described.FailureReason ?? "unknown"}) — recreating`,
            );
            yield* sagemaker
              .deleteEndpoint({ EndpointName: name })
              .pipe(Effect.catchTag("EndpointNotFound", () => Effect.void));
            yield* waitForEndpoint(name, "Gone");
            described = undefined;
          }

          // Ensure — create if missing; tolerate the already-exists race.
          if (described === undefined) {
            yield* sagemaker
              .createEndpoint({
                EndpointName: name,
                EndpointConfigName: news.endpointConfigName,
                DeploymentConfig: news.deploymentConfig,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("EndpointAlreadyExists", () => Effect.void),
              );
            yield* session.note(`Creating endpoint ${name}...`);
          } else if (
            described.EndpointConfigName !== news.endpointConfigName &&
            described.EndpointStatus === "InService"
          ) {
            // Sync — roll the live endpoint onto the desired configuration.
            yield* sagemaker.updateEndpoint({
              EndpointName: name,
              EndpointConfigName: news.endpointConfigName,
              DeploymentConfig: news.deploymentConfig,
            });
            yield* session.note(
              `Updating endpoint ${name} to config ${news.endpointConfigName}...`,
            );
          }

          // Converge to InService (also settles Creating/Updating states we
          // observed mid-flight, e.g. after a crashed reconcile).
          yield* waitForEndpoint(name, "InService");
          const final = yield* describeEndpointOrUndefined(name);
          if (final === undefined) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled endpoint ${name}`),
            );
          }

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchEndpointTags(final.EndpointArn);
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: final.EndpointArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: final.EndpointArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(final.EndpointArn);
          return {
            endpointName: final.EndpointName,
            endpointArn: final.EndpointArn,
            endpointStatus: final.EndpointStatus,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sagemaker
            .deleteEndpoint({ EndpointName: output.endpointName })
            .pipe(Effect.catchTag("EndpointNotFound", () => Effect.void));
          yield* waitForEndpoint(output.endpointName, "Gone");
        }),
      };
    }),
  );
