import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import type { Providers } from "../Providers.ts";
import { retryOnApiStatusUpdating } from "./common.ts";
import type { RestApi, RestApiBinding } from "./RestApi.ts";

export interface DeploymentProps {
  /**
   * The `RestApi` to deploy. When supplied, the Deployment reads every
   * `RestApiBinding` already registered on the API (each `Method`,
   * `Resource`, etc. that was declared with `restApi: api`) and pulls
   * those into its dependency graph. Adding a new `Method` automatically
   * causes the next apply to produce a fresh deployment — no user-authored
   * `DependsOn` or `triggers` hash required.
   */
  restApi?: RestApi;
  /**
   * ID of the REST API. Usually derived from `restApi.restApiId`; supply
   * explicitly only when not using `restApi`.
   */
  restApiId?: Input<string>;
  description?: string;
  stageName?: string;
  stageDescription?: string;
  cacheClusterEnabled?: boolean;
  cacheClusterSize?: ag.CacheClusterSize;
  variables?: { [key: string]: string | undefined };
  canarySettings?: ag.DeploymentCanarySettings;
  tracingEnabled?: boolean;
  /**
   * Opaque key/value map; when any value changes, a replacement deployment
   * is planned. Each value may be a literal string or an `Input<string>`
   * (such as a resource output) — output references create real dependency
   * edges, which is how Alchemy ensures a new deployment runs after the
   * resources it references are updated.
   *
   * You rarely need to set this manually: when you pass `restApi`, the
   * deployment already depends on every bound `Method` and redeploys
   * automatically when any of them change. Reach for `triggers` only when
   * you want to force a redeploy on some other signal (e.g. a config hash,
   * a manual version bump).
   */
  triggers?: Record<string, Input<string>>;
}

export interface DeploymentType extends Resource<
  "AWS.ApiGateway.Deployment",
  DeploymentProps,
  {
    deploymentId: string;
    restApiId: string;
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A point-in-time snapshot of a REST API, ready to be served through a
 * `Stage`.
 *
 * @section Creating a deployment
 * A Deployment captures whatever methods, integrations, resources, and
 * authorizers currently exist on the REST API and produces an immutable
 * `deploymentId` that a `Stage` can point at. Pass the `RestApi` value on
 * `restApi` and Alchemy handles all the ordering for you — the deployment
 * will run after every method bound to the API.
 *
 * @example Deployment of a REST API
 * ```typescript
 * const api = yield* ApiGateway.RestApi("Api", {
 *   endpointConfiguration: { types: ["REGIONAL"] },
 * });
 *
 * yield* ApiGateway.Method("GetRoot", {
 *   restApi: api,
 *   httpMethod: "GET",
 *   authorizationType: "NONE",
 *   integration: { type: "MOCK" },
 * });
 *
 * const deployment = yield* ApiGateway.Deployment("Release", {
 *   restApi: api,
 *   description: "v1",
 * });
 * ```
 *
 * @section Forcing a redeploy
 * Usually you do not have to: `restApi` already makes the Deployment
 * depend on every method, so any change to a method re-plans a new
 * deployment. Use `triggers` when you want to couple the deployment to a
 * signal Alchemy cannot see — for example, a manual version bump or a
 * hash of configuration computed outside the stack.
 *
 * @example Force redeploy on a version bump
 * ```typescript
 * const deployment = yield* ApiGateway.Deployment("Release", {
 *   restApi: api,
 *   triggers: { version: "2026-05-01" },
 * });
 * ```
 *
 * @section Why no DependsOn?
 * CloudFormation's `AWS::ApiGateway::Deployment` famously requires a
 * hand-written `DependsOn: [Method1, Method2, ...]` listing every method.
 * Alchemy derives that list automatically from the bindings registered on
 * the `RestApi`, so adding a method never requires editing the deployment.
 */
export const DeploymentResource = Resource<DeploymentType>(
  "AWS.ApiGateway.Deployment",
);

interface DeploymentInputProps {
  restApi?: RestApi;
  restApiId?: Input<string>;
  description?: Input<string>;
  stageName?: Input<string>;
  stageDescription?: Input<string>;
  cacheClusterEnabled?: Input<boolean>;
  cacheClusterSize?: Input<ag.CacheClusterSize>;
  variables?: Input<{ [key: string]: string | undefined }>;
  canarySettings?: Input<ag.DeploymentCanarySettings>;
  tracingEnabled?: Input<boolean>;
  triggers?: Record<string, Input<string>>;
}

/**
 * User-facing wrapper that adds a dependency edge from the Deployment to
 * every resource bound to the supplied `restApi`. Implementation detail:
 * each binding's output references get copied into the deployment's
 * `triggers` map so `resolveUpstream` sees them as real upstream dependencies.
 */
export const Deployment = (id: string, props: DeploymentInputProps) =>
  Effect.gen(function* () {
    const { restApi, ...rest } = props;
    const restApiId = rest.restApiId ?? restApi?.restApiId;
    if (!restApiId) {
      return yield* Effect.die(
        "Deployment requires either `restApi` (preferred) or explicit " +
          "`restApiId`.",
      );
    }
    let triggers: Record<string, Input<string>> | undefined = rest.triggers;
    if (restApi) {
      const stack = yield* Stack;
      const bindings = stack.bindings[restApi.FQN] ?? [];
      const autoTriggers: Record<string, Input<string>> = {};
      for (const b of bindings) {
        autoTriggers[`@alchemy:binding:${b.sid}`] = bindingDigest(b.data);
      }
      triggers = { ...autoTriggers, ...(triggers ?? {}) };
    }
    return yield* DeploymentResource(id, {
      ...rest,
      restApiId,
      triggers,
    } as any);
  });

/**
 * Serializes a binding payload down to a deterministic `Input<string>` so
 * it can ride along as a trigger value. The inner `Output.all` is what
 * surfaces the underlying resource FQNs to the dependency resolver.
 */
const bindingDigest = (data: RestApiBinding): Input<string> => {
  const entries = Object.entries(data as Record<string, unknown>).filter(
    ([k]) => k !== "kind",
  );
  const values = entries.map(([, v]) =>
    Output.asOutput(v as string | Output.Output<string>),
  );
  return Output.map(Output.all(...values), (parts) =>
    [data.kind, ...(parts as unknown as unknown[]).map(String)].join("|"),
  );
};

const embedTriggers = (
  description: string | undefined,
  triggers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    if (!triggers || Object.keys(triggers).length === 0) {
      return description;
    }
    const fp = yield* Effect.sync(() =>
      createHash("sha256")
        .update(JSON.stringify(triggers))
        .digest("hex")
        .slice(0, 24),
    );
    const suffix = `@alchemy:triggers:${fp}`;
    return description ? `${description}\n${suffix}` : suffix;
  });

export const DeploymentProvider = () =>
  Provider.effect(
    DeploymentResource,
    Effect.gen(function* () {
      return {
        stables: ["deploymentId", "restApiId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<DeploymentProps>;
          const oldsP = olds as Input.ResolveProps<DeploymentProps>;
          if (news.restApiId !== oldsP.restApiId) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(news.triggers, oldsP.triggers)) {
            return { action: "replace" } as const;
          }
          if (
            news.stageName !== oldsP.stageName ||
            news.stageDescription !== oldsP.stageDescription ||
            news.cacheClusterEnabled !== oldsP.cacheClusterEnabled ||
            news.cacheClusterSize !== oldsP.cacheClusterSize ||
            !deepEqual(news.variables, oldsP.variables) ||
            !deepEqual(news.canarySettings, oldsP.canarySettings) ||
            news.tracingEnabled !== oldsP.tracingEnabled
          ) {
            return { action: "replace" } as const;
          }
          if (news.description !== oldsP.description) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.deploymentId) return undefined;
          const d = yield* ag
            .getDeployment({
              restApiId: output.restApiId,
              deploymentId: output.deploymentId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!d?.id) return undefined;
          return {
            deploymentId: d.id,
            restApiId: output.restApiId,
            description: d.description,
          };
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Deployment props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<DeploymentProps>;
          const description = yield* embedTriggers(
            news.description,
            news.triggers as Record<string, string> | undefined,
          );
          const restApiId = (output?.restApiId ?? news.restApiId) as string;

          // Observe — fetch the live deployment if we have a cached id.
          // A Deployment is immutable apart from `description`, so we never
          // trust a stale `output.description` for diffing.
          let observed = output?.deploymentId
            ? yield* ag
                .getDeployment({
                  restApiId,
                  deploymentId: output.deploymentId,
                })
                .pipe(
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;

          // Ensure — create a new deployment if there isn't one yet.
          // `createDeployment` always produces a fresh deploymentId, so we
          // only call it when missing; any change that should produce a new
          // deployment is modeled as `replace` in `diff`.
          if (!observed?.id) {
            const created = yield* retryOnApiStatusUpdating(
              ag.createDeployment({
                restApiId: news.restApiId as string,
                stageName: news.stageName,
                stageDescription: news.stageDescription,
                description,
                cacheClusterEnabled: news.cacheClusterEnabled,
                cacheClusterSize: news.cacheClusterSize,
                variables: news.variables,
                canarySettings: news.canarySettings,
                tracingEnabled: news.tracingEnabled,
              }),
            );
            if (!created.id)
              return yield* Effect.die("createDeployment missing id");
            yield* session.note(`Created deployment ${created.id}`);
            observed = yield* ag.getDeployment({
              restApiId: news.restApiId as string,
              deploymentId: created.id,
            });
          }

          const deploymentId = observed.id!;

          // Sync description — observed ↔ desired.
          if (description !== observed.description) {
            yield* retryOnApiStatusUpdating(
              ag.updateDeployment({
                restApiId,
                deploymentId,
                patchOperations: description
                  ? [
                      {
                        op: "replace",
                        path: "/description",
                        value: description,
                      },
                    ]
                  : [{ op: "remove", path: "/description" }],
              }),
            );
          }

          yield* session.note(`Reconciled deployment ${deploymentId}`);
          const final = yield* ag.getDeployment({
            restApiId,
            deploymentId,
          });
          return {
            deploymentId,
            restApiId,
            description: final?.description,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnApiStatusUpdating(
            ag
              .deleteDeployment({
                restApiId: output.restApiId,
                deploymentId: output.deploymentId,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted deployment ${output.deploymentId}`);
        }),
      };
    }),
  );
