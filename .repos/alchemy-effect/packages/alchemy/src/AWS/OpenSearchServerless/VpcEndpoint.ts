import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { awaitVpcEndpointActive, retryWhileConflict } from "./internal.ts";

export interface VpcEndpointProps {
  /**
   * Name of the VPC endpoint (3-32 characters, lowercase). Changing the name
   * replaces the endpoint.
   * @default a generated physical name
   */
  endpointName?: string;
  /**
   * The ID of the VPC from which the endpoint accesses OpenSearch Serverless.
   * Changing the VPC replaces the endpoint.
   */
  vpcId: string;
  /**
   * The IDs of the subnets in which to create the interface endpoint's network
   * interfaces.
   */
  subnetIds: string[];
  /**
   * The IDs of the security groups to attach to the endpoint's network
   * interfaces.
   */
  securityGroupIds?: string[];
}

export interface VpcEndpoint extends Resource<
  "AWS.OpenSearchServerless.VpcEndpoint",
  VpcEndpointProps,
  {
    /**
     * Unique identifier of the VPC endpoint.
     */
    vpcEndpointId: string;
    /**
     * Name of the VPC endpoint.
     */
    endpointName: string;
    /**
     * Endpoint status (e.g. `ACTIVE`, `PENDING`, `DELETING`).
     */
    status?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon OpenSearch Serverless-managed interface VPC endpoint. Creating one
 * lets resources in a VPC reach a collection privately (without traversing the
 * public internet), and lets a network {@link SecurityPolicy} restrict a
 * collection's access to only that endpoint. Creation is asynchronous — the
 * provider polls (bounded) until the endpoint reaches `ACTIVE`.
 *
 * @resource
 * @section Creating VPC Endpoints
 * @example Interface Endpoint in a VPC
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const endpoint = yield* AWS.OpenSearchServerless.VpcEndpoint("Endpoint", {
 *   endpointName: "my-endpoint",
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 * });
 * ```
 */
export const VpcEndpoint = Resource<VpcEndpoint>(
  "AWS.OpenSearchServerless.VpcEndpoint",
);

export const VpcEndpointProvider = () =>
  Provider.effect(
    VpcEndpoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { endpointName?: string | undefined },
      ) {
        return (
          props.endpointName ??
          (yield* createPhysicalName({ id, maxLength: 32, lowercase: true }))
        );
      });

      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* aoss.listVpcEndpoints
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.vpcEndpointSummaries ?? [])
          .find((s) => s.name === name);
      });

      const observe = Effect.fn(function* (
        name: string,
        vpcEndpointId: string | undefined,
      ) {
        if (vpcEndpointId !== undefined) {
          const byId = yield* aoss
            .batchGetVpcEndpoint({ ids: [vpcEndpointId] })
            .pipe(Effect.map((r) => r.vpcEndpointDetails?.[0]));
          if (byId?.id !== undefined && byId.status !== "DELETING") {
            return byId;
          }
        }
        const summary = yield* findByName(name);
        if (summary?.id === undefined || summary.status === "DELETING") {
          return undefined;
        }
        return yield* aoss
          .batchGetVpcEndpoint({ ids: [summary.id] })
          .pipe(Effect.map((r) => r.vpcEndpointDetails?.[0]));
      });

      return VpcEndpoint.Provider.of({
        stables: ["vpcEndpointId", "endpointName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* aoss.listVpcEndpoints
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.vpcEndpointSummaries ?? [])
              .filter((s) => s.id !== undefined && s.name !== undefined)
              .map((s) => ({
                vpcEndpointId: s.id!,
                endpointName: s.name!,
                status: s.status,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.endpointName ?? (yield* createName(id, olds ?? {}));
          const detail = yield* observe(name, output?.vpcEndpointId);
          if (detail?.id === undefined) {
            return undefined;
          }
          // VPC endpoints carry no tags — an existing same-name endpoint is
          // adopted.
          return {
            vpcEndpointId: detail.id,
            endpointName: detail.name!,
            status: detail.status,
          };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (olds.vpcId !== news.vpcId) {
            return { action: "replace" } as const;
          }
          // subnetIds/securityGroupIds fall through to the default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.endpointName ?? (yield* createName(id, news));

          // 1. OBSERVE
          let detail = yield* observe(name, output?.vpcEndpointId);

          // 2. ENSURE — create if missing; wait for ACTIVE (async provisioning)
          if (detail === undefined) {
            const created = yield* aoss
              .createVpcEndpoint({
                name,
                vpcId: news.vpcId,
                subnetIds: news.subnetIds,
                securityGroupIds: news.securityGroupIds,
              })
              .pipe(
                Effect.map((r) => r.createVpcEndpointDetail),
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            const endpointId = created?.id ?? (yield* findByName(name))?.id;
            if (endpointId === undefined) {
              return yield* Effect.fail(
                new aoss.ResourceNotFoundException({
                  message: `VPC endpoint ${name} not visible after create`,
                }),
              );
            }
            yield* session.note(`creating VPC endpoint ${name} (async)...`);
            detail = yield* awaitVpcEndpointActive(endpointId);
          } else if (detail.status !== "ACTIVE") {
            detail = yield* awaitVpcEndpointActive(detail.id!);
          }

          // 3. SYNC — subnet/security-group membership deltas
          const observedSubnets = new Set(detail.subnetIds ?? []);
          const desiredSubnets = new Set(news.subnetIds);
          const addSubnetIds = news.subnetIds.filter(
            (s) => !observedSubnets.has(s),
          );
          const removeSubnetIds = (detail.subnetIds ?? []).filter(
            (s) => !desiredSubnets.has(s),
          );
          const observedSgs = new Set(detail.securityGroupIds ?? []);
          const desiredSgs = new Set(news.securityGroupIds ?? []);
          const addSecurityGroupIds = (news.securityGroupIds ?? []).filter(
            (s) => !observedSgs.has(s),
          );
          const removeSecurityGroupIds = (detail.securityGroupIds ?? []).filter(
            (s) => !desiredSgs.has(s),
          );
          if (
            addSubnetIds.length > 0 ||
            removeSubnetIds.length > 0 ||
            addSecurityGroupIds.length > 0 ||
            removeSecurityGroupIds.length > 0
          ) {
            yield* aoss.updateVpcEndpoint({
              id: detail.id!,
              addSubnetIds: addSubnetIds.length > 0 ? addSubnetIds : undefined,
              removeSubnetIds:
                removeSubnetIds.length > 0 ? removeSubnetIds : undefined,
              addSecurityGroupIds:
                addSecurityGroupIds.length > 0
                  ? addSecurityGroupIds
                  : undefined,
              removeSecurityGroupIds:
                removeSecurityGroupIds.length > 0
                  ? removeSecurityGroupIds
                  : undefined,
            });
          }

          yield* session.note(detail.id!);
          return {
            vpcEndpointId: detail.id!,
            endpointName: detail.name!,
            status: detail.status,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            aoss.deleteVpcEndpoint({ id: output.vpcEndpointId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
