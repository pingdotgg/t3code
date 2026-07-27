import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { awaitOperation, retryWhileResourceInUse } from "./internal.ts";

export interface InstanceRegistrationProps {
  /**
   * The ID of the Cloud Map service to register the instance with.
   * Changing the service replaces the registration.
   */
  serviceId: string;
  /**
   * The instance ID — unique within the service. Changing it replaces the
   * registration.
   */
  instanceId: string;
  /**
   * Instance attributes. For DNS services these drive record creation:
   * `AWS_INSTANCE_IPV4` (A records), `AWS_INSTANCE_IPV6` (AAAA),
   * `AWS_INSTANCE_PORT` (SRV), `AWS_INSTANCE_CNAME` (CNAME). Custom keys are
   * returned by `DiscoverInstances`. Mutable — re-registering with the same
   * instance ID updates the attributes.
   */
  attributes: Record<string, string>;
}

export interface InstanceRegistration extends Resource<
  "AWS.CloudMap.InstanceRegistration",
  InstanceRegistrationProps,
  {
    /**
     * The Cloud Map service the instance is registered with.
     */
    serviceId: string;
    /**
     * The identifier of the registered instance.
     */
    instanceId: string;
  },
  {},
  Providers
> {}

/**
 * A manual AWS Cloud Map instance registration — registers a static
 * endpoint (an IP, port, CNAME, or an arbitrary attribute bag) with a Cloud
 * Map service so it is returned by `DiscoverInstances` and, for DNS
 * services, resolvable via Route 53.
 *
 * Use this for non-ECS targets: static IPs, on-prem hosts, external
 * dependencies. ECS registers its own tasks automatically via
 * `serviceRegistries`.
 *
 * `RegisterInstance` is an upsert — reconcile re-registers with the desired
 * attributes and Cloud Map converges the records. Registration and
 * deregistration are asynchronous; the provider polls the operations API
 * (bounded) until they complete.
 * @resource
 * @section Registering Instances
 * @example Register a Static IP
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const instance = yield* AWS.CloudMap.InstanceRegistration("Primary", {
 *   serviceId: service.serviceId,
 *   instanceId: "primary",
 *   attributes: { AWS_INSTANCE_IPV4: "10.0.1.10" },
 * });
 * ```
 *
 * @example Register an API-only Instance with Custom Attributes
 * ```typescript
 * const instance = yield* AWS.CloudMap.InstanceRegistration("Worker", {
 *   serviceId: service.serviceId,
 *   instanceId: "worker-1",
 *   attributes: { endpoint: "https://worker-1.internal:8443", zone: "us-west-2a" },
 * });
 * ```
 */
export const InstanceRegistration = Resource<InstanceRegistration>(
  "AWS.CloudMap.InstanceRegistration",
);

export const InstanceRegistrationProvider = () =>
  Provider.effect(
    InstanceRegistration,
    Effect.gen(function* () {
      return InstanceRegistration.Provider.of({
        stables: ["serviceId", "instanceId"],

        // Sub-resource keyed by its parent service — there is no
        // account-level enumeration without a service id, so listing is
        // handled by the parent's lifecycle.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const serviceId = output?.serviceId ?? olds?.serviceId;
          const instanceId = output?.instanceId ?? olds?.instanceId;
          if (serviceId === undefined || instanceId === undefined) {
            return undefined;
          }
          const instance = yield* sd
            .getInstance({ ServiceId: serviceId, InstanceId: instanceId })
            .pipe(
              Effect.map((r) => r.Instance),
              Effect.catchTag(["InstanceNotFound", "ServiceNotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          if (instance === undefined) {
            return undefined;
          }
          // instances carry no tags, so ownership can't be branded — treat
          // presence as ours (identity is fully determined by the props)
          return { serviceId, instanceId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.serviceId !== news.serviceId ||
            olds.instanceId !== news.instanceId
          ) {
            return { action: "replace" } as const;
          }
          // attributes fall through to the default update path (upsert)
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // OBSERVE — compare live attributes so an unchanged registration
          // is a no-op instead of a Route 53 record churn
          const observed = yield* sd
            .getInstance({
              ServiceId: news.serviceId,
              InstanceId: news.instanceId,
            })
            .pipe(
              Effect.map((r) => r.Instance),
              Effect.catchTag(["InstanceNotFound", "ServiceNotFound"], () =>
                Effect.succeed(undefined),
              ),
            );

          const observedAttributes = observed?.Attributes ?? undefined;
          const desiredEntries = Object.entries(news.attributes);
          const matches =
            observedAttributes !== undefined &&
            desiredEntries.length === Object.keys(observedAttributes).length &&
            desiredEntries.every(
              ([key, value]) => observedAttributes[key] === value,
            );

          // ENSURE/SYNC — registerInstance is a create-or-update upsert
          if (!matches) {
            const registered = yield* retryWhileResourceInUse(
              sd.registerInstance({
                ServiceId: news.serviceId,
                InstanceId: news.instanceId,
                Attributes: news.attributes,
              }),
            );
            if (registered.OperationId !== undefined) {
              yield* awaitOperation(registered.OperationId);
            }
          }

          yield* session.note(news.instanceId);
          return { serviceId: news.serviceId, instanceId: news.instanceId };
        }),

        delete: Effect.fn(function* ({ output }) {
          const deregistered = yield* retryWhileResourceInUse(
            sd.deregisterInstance({
              ServiceId: output.serviceId,
              InstanceId: output.instanceId,
            }),
          ).pipe(
            Effect.catchTag(["InstanceNotFound", "ServiceNotFound"], () =>
              Effect.succeed({ OperationId: undefined }),
            ),
            // an identical deregistration is already in flight — await THAT
            // operation instead of silently skipping it
            Effect.catchTag("DuplicateRequest", (e) =>
              Effect.succeed({ OperationId: e.DuplicateOperationId }),
            ),
          );
          if (deregistered.OperationId !== undefined) {
            yield* awaitOperation(deregistered.OperationId);
          }
        }),
      });
    }),
  );
