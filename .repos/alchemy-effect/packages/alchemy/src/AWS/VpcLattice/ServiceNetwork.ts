import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
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
import type { Providers } from "../Providers.ts";
import { retryOnConflict, waitUntilAbsent } from "./internal.ts";

/**
 * Authorization mode for a service network. `NONE` allows all traffic;
 * `AWS_IAM` requires an auth policy.
 */
export type ServiceNetworkAuthType = "NONE" | "AWS_IAM";

export interface ServiceNetworkProps {
  /**
   * Name of the service network. If omitted, a unique name is generated.
   * Immutable — changing it replaces the resource.
   */
  name?: string;
  /**
   * Authorization type for the network.
   * @default "NONE"
   */
  authType?: ServiceNetworkAuthType;
  /**
   * User-defined tags to apply to the service network.
   */
  tags?: Record<string, string>;
}

export interface ServiceNetwork extends Resource<
  "AWS.VpcLattice.ServiceNetwork",
  ServiceNetworkProps,
  {
    /**
     * Service-assigned unique ID of the service network.
     */
    serviceNetworkId: string;
    /**
     * ARN of the service network.
     */
    serviceNetworkArn: string;
    /**
     * Physical name of the service network.
     */
    name: string;
    /**
     * Effective authorization type.
     */
    authType: ServiceNetworkAuthType;
    /**
     * Current tags reported for the service network.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon VPC Lattice service network — the logical boundary that connects
 * services and VPCs into one application network. Cheap control-plane resource
 * with no per-hour charge until VPCs or services are associated.
 *
 * @resource
 * @section Creating Service Networks
 * @example Basic Service Network
 * ```typescript
 * const network = yield* ServiceNetwork("AppNetwork", {});
 * ```
 *
 * @example IAM-Authorized Network
 * ```typescript
 * const network = yield* ServiceNetwork("SecureNetwork", {
 *   authType: "AWS_IAM",
 *   tags: { Environment: "prod" },
 * });
 * ```
 */
export const ServiceNetwork = Resource<ServiceNetwork>(
  "AWS.VpcLattice.ServiceNetwork",
);

export const ServiceNetworkProvider = () =>
  Provider.effect(
    ServiceNetwork,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      // getServiceNetwork only accepts an id or ARN — never a name. Look up by
      // id when we have one, and fall back to enumerating for name-based
      // discovery (adoption / lost-state recovery / create-conflict recovery).
      const observe = (serviceNetworkIdentifier: string) =>
        vpclattice
          .getServiceNetwork({ serviceNetworkIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (name: string) =>
        vpclattice.listServiceNetworks.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.items ?? [])
              .find((s) => s.name === name),
          ),
          Effect.flatMap((summary) =>
            summary?.id ? observe(summary.id) : Effect.succeed(undefined),
          ),
        );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      const isOwnedAssociation = Effect.fn(function* (
        arn: string,
        ownerTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice
          .listTagsForResource({ resourceArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (!listed) return false;
        const tags = tagRecord(listed.tags);
        return (
          tags["alchemy::id"] !== undefined &&
          tags["alchemy::stack"] === ownerTags["alchemy::stack"] &&
          tags["alchemy::stage"] === ownerTags["alchemy::stage"]
        );
      });

      const deleteVpcAssociations = Effect.fn(function* (
        serviceNetworkId: string,
        ownerTags: Record<string, string>,
        force: boolean,
      ) {
        const pages = yield* vpclattice.listServiceNetworkVpcAssociations
          .pages({ serviceNetworkIdentifier: serviceNetworkId })
          .pipe(Stream.runCollect);
        const associations = Array.from(pages).flatMap(
          (page) => page.items ?? [],
        );
        yield* Effect.forEach(
          associations,
          (association) =>
            Effect.gen(function* () {
              if (
                !association.id ||
                !association.arn ||
                (!force &&
                  !(yield* isOwnedAssociation(association.arn, ownerTags)))
              ) {
                return;
              }
              yield* retryOnConflict(
                vpclattice.deleteServiceNetworkVpcAssociation({
                  serviceNetworkVpcAssociationIdentifier: association.id,
                }),
              ).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
              yield* waitUntilAbsent(
                vpclattice
                  .getServiceNetworkVpcAssociation({
                    serviceNetworkVpcAssociationIdentifier: association.id,
                  })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              );
            }),
          { concurrency: 10 },
        );
      });

      const deleteServiceAssociations = Effect.fn(function* (
        serviceNetworkId: string,
        ownerTags: Record<string, string>,
        force: boolean,
      ) {
        const pages = yield* vpclattice.listServiceNetworkServiceAssociations
          .pages({ serviceNetworkIdentifier: serviceNetworkId })
          .pipe(Stream.runCollect);
        const associations = Array.from(pages).flatMap(
          (page) => page.items ?? [],
        );
        yield* Effect.forEach(
          associations,
          (association) =>
            Effect.gen(function* () {
              if (
                !association.id ||
                !association.arn ||
                (!force &&
                  !(yield* isOwnedAssociation(association.arn, ownerTags)))
              ) {
                return;
              }
              yield* retryOnConflict(
                vpclattice.deleteServiceNetworkServiceAssociation({
                  serviceNetworkServiceAssociationIdentifier: association.id,
                }),
              ).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
              yield* waitUntilAbsent(
                vpclattice
                  .getServiceNetworkServiceAssociation({
                    serviceNetworkServiceAssociationIdentifier: association.id,
                  })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              );
            }),
          { concurrency: 10 },
        );
      });

      const deleteResourceAssociations = Effect.fn(function* (
        serviceNetworkId: string,
        ownerTags: Record<string, string>,
        force: boolean,
      ) {
        const pages = yield* vpclattice.listServiceNetworkResourceAssociations
          .pages({ serviceNetworkIdentifier: serviceNetworkId })
          .pipe(Stream.runCollect);
        const associations = Array.from(pages).flatMap(
          (page) => page.items ?? [],
        );
        yield* Effect.forEach(
          associations,
          (association) =>
            Effect.gen(function* () {
              if (
                !association.id ||
                !association.arn ||
                (!force &&
                  !(yield* isOwnedAssociation(association.arn, ownerTags)))
              ) {
                return;
              }
              yield* retryOnConflict(
                vpclattice.deleteServiceNetworkResourceAssociation({
                  serviceNetworkResourceAssociationIdentifier: association.id,
                }),
              ).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
              yield* waitUntilAbsent(
                vpclattice
                  .getServiceNetworkResourceAssociation({
                    serviceNetworkResourceAssociationIdentifier: association.id,
                  })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              );
            }),
          { concurrency: 10 },
        );
      });

      return {
        stables: ["serviceNetworkId", "serviceNetworkArn", "name"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const network = output?.serviceNetworkId
            ? yield* observe(output.serviceNetworkId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (!network?.arn || !network.id) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: network.arn,
          });
          const attrs = {
            serviceNetworkId: network.id,
            serviceNetworkArn: network.arn,
            name: network.name!,
            authType: (network.authType as ServiceNetworkAuthType) ?? "NONE",
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredAuthType = news.authType ?? "NONE";

          // Observe — prefer the stable id cache, fall back to name lookup.
          let network = output?.serviceNetworkId
            ? yield* observe(output.serviceNetworkId)
            : yield* findByName(name);

          // Ensure — create if missing.
          if (!network?.arn || !network.id) {
            network = yield* vpclattice
              .createServiceNetwork({ name, authType: desiredAuthType })
              .pipe(
                Effect.catchTag("ConflictException", () => findByName(name)),
              );
            if (!network?.arn || !network.id) {
              return yield* Effect.fail(
                new Error(`Failed to create service network ${name}`),
              );
            }
          } else if ((network.authType ?? "NONE") !== desiredAuthType) {
            // Sync auth type — the only mutable setting.
            yield* vpclattice.updateServiceNetwork({
              serviceNetworkIdentifier: network.id,
              authType: desiredAuthType,
            });
          }

          yield* syncTags(network.arn, desiredTags);

          yield* session.note(network.arn);
          return {
            serviceNetworkId: network.id,
            serviceNetworkArn: network.arn,
            name,
            authType: desiredAuthType,
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* vpclattice.listServiceNetworks
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.items ?? []),
                ),
              );
            return yield* Effect.forEach(
              summaries.filter(
                (s): s is typeof s & { id: string; arn: string } =>
                  s.id != null && s.arn != null,
              ),
              (summary) =>
                Effect.gen(function* () {
                  const network = yield* observe(summary.id);
                  const listed = yield* vpclattice.listTagsForResource({
                    resourceArn: summary.arn,
                  });
                  return {
                    serviceNetworkId: summary.id,
                    serviceNetworkArn: summary.arn,
                    name: summary.name!,
                    authType:
                      (network?.authType as ServiceNetworkAuthType) ?? "NONE",
                    tags: tagRecord(listed.tags),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output, force }) {
          if (!(yield* observe(output.serviceNetworkId))) {
            return;
          }
          // Nuke discovers resources independently and therefore cannot rely on
          // the stack dependency graph to order association deletion before the
          // service network. An operator-confirmed nuke may remove every
          // attached association blocking deletion. Ordinary stack deletion is
          // deliberately conservative and removes only associations owned by
          // the same Alchemy stack/stage.
          yield* Effect.all(
            [
              deleteVpcAssociations(
                output.serviceNetworkId,
                output.tags,
                force === true,
              ),
              deleteServiceAssociations(
                output.serviceNetworkId,
                output.tags,
                force === true,
              ),
              deleteResourceAssociations(
                output.serviceNetworkId,
                output.tags,
                force === true,
              ),
            ],
            { concurrency: 3 },
          );
          yield* retryOnConflict(
            vpclattice.deleteServiceNetwork({
              serviceNetworkIdentifier: output.serviceNetworkId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* waitUntilAbsent(observe(output.serviceNetworkId));
        }),
      };
    }),
  );
