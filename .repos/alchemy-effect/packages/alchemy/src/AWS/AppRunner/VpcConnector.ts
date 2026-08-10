import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  isActiveStatus,
  readAppRunnerTags,
  syncAppRunnerTags,
  toWireTags,
} from "./internal.ts";

export interface VpcConnectorProps {
  /**
   * Name of the VPC connector. Must be 4-40 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the connector.
   */
  vpcConnectorName?: string;
  /**
   * IDs of the VPC subnets App Runner uses for outgoing (egress) traffic.
   * All subnets must belong to the same VPC. VPC connectors are
   * immutable — changing subnets replaces the connector.
   */
  subnets: string[];
  /**
   * IDs of the security groups applied to the connector's network
   * interfaces. Changing security groups replaces the connector.
   * @default the VPC's default security group
   */
  securityGroups?: string[];
  /**
   * User-defined tags for the connector.
   */
  tags?: Record<string, string>;
}

export interface VpcConnector extends Resource<
  "AWS.AppRunner.VpcConnector",
  VpcConnectorProps,
  {
    /**
     * Name of the VPC connector.
     */
    vpcConnectorName: string;
    /**
     * ARN of this VPC connector revision.
     */
    vpcConnectorArn: string;
    /**
     * Revision number of the connector (revisions are immutable).
     */
    vpcConnectorRevision: number;
    /**
     * Subnets the connector attaches to.
     */
    subnets: string[];
    /**
     * Security groups applied to outbound traffic.
     */
    securityGroups: string[];
    /**
     * Current status of the connector (e.g. `ACTIVE`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS App Runner VPC connector. Associating a connector with an App
 * Runner service routes the service's outbound traffic through your VPC
 * (e.g. to reach an RDS database in private subnets).
 *
 * VPC connectors are immutable: any change to subnets or security groups
 * replaces the connector.
 * @resource
 * @section Creating a VPC Connector
 * @example Connector over Two Subnets
 * ```typescript
 * const connector = yield* AppRunner.VpcConnector("Egress", {
 *   subnets: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroups: [egressSecurityGroup.securityGroupId],
 * });
 * ```
 *
 * @section Routing a Service through the VPC
 * @example Service with VPC Egress
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: image.imageUri,
 *     imageRepositoryType: "ECR",
 *     port: "8080",
 *   },
 *   accessRoleArn: accessRole.roleArn,
 *   networkConfiguration: {
 *     egressType: "VPC",
 *     vpcConnectorArn: connector.vpcConnectorArn,
 *   },
 * });
 * ```
 */
export const VpcConnector = Resource<VpcConnector>(
  "AWS.AppRunner.VpcConnector",
);

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

class VpcConnectorStillActive extends Data.TaggedError(
  "VpcConnectorStillActive",
)<{
  readonly vpcConnectorArn: string;
  readonly status: string;
}> {}

export const VpcConnectorProvider = () =>
  Provider.effect(
    VpcConnector,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<VpcConnectorProps>) =>
        props.vpcConnectorName
          ? Effect.succeed(props.vpcConnectorName)
          : createPhysicalName({ id, maxLength: 40 });

      const listConnectors = () =>
        apprunner.listVpcConnectors.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.VpcConnectors ?? []),
          ),
        );

      /**
       * Find the latest ACTIVE revision of a connector by name. The list
       * API has no name filter, so enumerate and filter client-side.
       */
      const findConnector = Effect.fn(function* (name: string) {
        const connectors = yield* listConnectors();
        return connectors
          .filter(
            (c) => c.VpcConnectorName === name && isActiveStatus(c.Status),
          )
          .sort(
            (a, b) =>
              (b.VpcConnectorRevision ?? 0) - (a.VpcConnectorRevision ?? 0),
          )[0];
      });

      const toAttrs = Effect.fn(function* (connector: apprunner.VpcConnector) {
        if (
          !connector.VpcConnectorName ||
          !connector.VpcConnectorArn ||
          connector.VpcConnectorRevision === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              "App Runner VPC connector is missing its name, ARN, or revision",
            ),
          );
        }
        return {
          vpcConnectorName: connector.VpcConnectorName,
          vpcConnectorArn: connector.VpcConnectorArn,
          vpcConnectorRevision: connector.VpcConnectorRevision,
          subnets: [...(connector.Subnets ?? [])],
          securityGroups: [...(connector.SecurityGroups ?? [])],
          status: connector.Status ?? "ACTIVE",
        };
      });

      return {
        stables: ["vpcConnectorName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // VPC connectors are immutable — subnet or security group
          // changes force a replacement.
          if (
            news?.subnets !== undefined &&
            olds?.subnets !== undefined &&
            !sameStringSet(news.subnets, olds.subnets)
          ) {
            return { action: "replace" } as const;
          }
          if (
            news?.securityGroups !== undefined &&
            olds?.securityGroups !== undefined &&
            !sameStringSet(news.securityGroups, olds.securityGroups)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.vpcConnectorName ?? (yield* toName(id, olds ?? {}));
          const connector = yield* findConnector(name);
          if (connector === undefined) return undefined;
          const attrs = yield* toAttrs(connector);
          const tags = yield* readAppRunnerTags(attrs.vpcConnectorArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.vpcConnectorName ?? (yield* toName(id, news ?? {}));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news?.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* findConnector(name);

          // 2. Ensure — the connector is immutable, so reconcile only
          // ensures existence (diff handles replacement on any change).
          if (observed === undefined) {
            const created = yield* apprunner.createVpcConnector({
              VpcConnectorName: name,
              Subnets: news?.subnets ?? [],
              SecurityGroups: news?.securityGroups,
              Tags: toWireTags(desiredTags),
            });
            observed = created.VpcConnector;
          }

          // 3. Sync tags — diff against OBSERVED cloud tags.
          if (observed.VpcConnectorArn) {
            yield* syncAppRunnerTags(observed.VpcConnectorArn, desiredTags);
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A connector still associated with a service (App Runner
          // releases the association asynchronously after the service
          // finishes deleting) rejects with InvalidRequestException —
          // retry through that window (bounded).
          yield* apprunner
            .deleteVpcConnector({
              VpcConnectorArn: output.vpcConnectorArn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) =>
                  e._tag === "InvalidRequestException" ||
                  e._tag === "InternalServiceErrorException",
                schedule: Schedule.fixed("5 seconds"),
                times: 8,
              }),
            );

          // App Runner retains deleted connector revisions as INACTIVE, so
          // INACTIVE is the service's terminal deleted state. Do not release
          // Alchemy state while the connector is still ACTIVE: App Runner's
          // managed ENIs would keep stack-owned subnets and security groups in
          // use and make their bottom-up teardown flaky.
          yield* apprunner
            .describeVpcConnector({
              VpcConnectorArn: output.vpcConnectorArn,
            })
            .pipe(
              Effect.flatMap(({ VpcConnector }) => {
                const status = (VpcConnector.Status ?? "ACTIVE").toUpperCase();
                return status === "INACTIVE"
                  ? Effect.void
                  : Effect.fail(
                      new VpcConnectorStillActive({
                        vpcConnectorArn: output.vpcConnectorArn,
                        status,
                      }),
                    );
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) =>
                  e._tag === "VpcConnectorStillActive" ||
                  e._tag === "InternalServiceErrorException",
                schedule: Schedule.fixed("3 seconds"),
                times: 10,
              }),
            );
        }),

        list: () =>
          listConnectors().pipe(
            Effect.map((connectors) =>
              connectors.filter((c) => isActiveStatus(c.Status)),
            ),
            Effect.flatMap(
              Effect.forEach((connector) => toAttrs(connector), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );
