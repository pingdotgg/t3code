import * as osis from "@distilled.cloud/aws/osis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { jsonEquals } from "./internal.ts";

export interface PipelineEndpointVpcOptions {
  /**
   * Subnet IDs the endpoint's network interfaces are placed into. Changing
   * subnets replaces the endpoint.
   */
  subnetIds: string[];
  /**
   * Security group IDs applied to the endpoint's network interfaces.
   * Changing security groups replaces the endpoint.
   */
  securityGroupIds?: string[];
}

export interface PipelineEndpointProps {
  /**
   * ARN of the OSIS pipeline the endpoint ingests into. Changing the
   * pipeline replaces the endpoint.
   */
  pipelineArn: string;
  /**
   * VPC placement for the endpoint. All fields are create-only — any change
   * replaces the endpoint.
   */
  vpcOptions: PipelineEndpointVpcOptions;
}

export interface PipelineEndpoint extends Resource<
  "AWS.OSIS.PipelineEndpoint",
  PipelineEndpointProps,
  {
    /**
     * Id of the pipeline endpoint (`pe-…`), assigned by OSIS on create.
     */
    endpointId: string;
    /**
     * ARN of the pipeline the endpoint ingests into.
     */
    pipelineArn: string;
    /**
     * Endpoint status (e.g. `ACTIVE`, `CREATING`, `REVOKED`).
     */
    status: string;
    /**
     * Id of the VPC the endpoint lives in.
     */
    vpcId: string | undefined;
    /**
     * The VPC-private ingest URL for the endpoint.
     */
    ingestEndpointUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A VPC endpoint for an Amazon OpenSearch Ingestion (OSIS) pipeline — lets
 * clients inside a VPC ingest data into a pipeline privately, without
 * traversing the public ingest endpoint.
 *
 * All properties are create-only; any change replaces the endpoint. The
 * endpoint id is assigned by OSIS on create.
 * @resource
 * @section Creating a Pipeline Endpoint
 * @example Private Ingest From a VPC
 * ```typescript
 * const endpoint = yield* OSIS.PipelineEndpoint("Private", {
 *   pipelineArn: pipeline.pipelineArn,
 *   vpcOptions: {
 *     subnetIds: [subnet.subnetId],
 *     securityGroupIds: [securityGroup.securityGroupId],
 *   },
 * });
 * // endpoint.ingestEndpointUrl — the VPC-private ingest URL
 * ```
 */
export const PipelineEndpoint = Resource<PipelineEndpoint>(
  "AWS.OSIS.PipelineEndpoint",
);

/**
 * A pipeline endpoint whose asynchronous create converged to a failed
 * status.
 */
export class PipelineEndpointCreateFailed extends Data.TaggedError(
  "OsisPipelineEndpointCreateFailed",
)<{
  readonly endpointId: string;
  readonly status: string;
}> {}

export const PipelineEndpointProvider = () =>
  Provider.effect(
    PipelineEndpoint,
    Effect.gen(function* () {
      /**
       * There is no `getPipelineEndpoint` — observe by enumerating the
       * account's endpoints and matching the id.
       */
      const findEndpoint = Effect.fn(function* (endpointId: string) {
        return yield* osis.listPipelineEndpoints.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.PipelineEndpoints ?? [])
              .find((endpoint) => endpoint.EndpointId === endpointId),
          ),
        );
      });

      const toAttrs = Effect.fn(function* (endpoint: osis.PipelineEndpoint) {
        if (!endpoint.EndpointId || !endpoint.PipelineArn) {
          return yield* Effect.fail(
            new Error(
              `OSIS pipeline endpoint '${endpoint.EndpointId}' is missing its id or pipeline ARN`,
            ),
          );
        }
        return {
          endpointId: endpoint.EndpointId,
          pipelineArn: endpoint.PipelineArn,
          status: endpoint.Status ?? "ACTIVE",
          vpcId: endpoint.VpcId,
          ingestEndpointUrl: endpoint.IngestEndpointUrl,
        };
      });

      /**
       * Endpoint creation provisions VPC network interfaces and typically
       * takes a few minutes. Bounded: 15s x 40 (~10 minutes). The explicit
       * return annotation is load-bearing — see `waitForPipelineSettled` in
       * `internal.ts`.
       */
      const waitForSettled = <E, R>(
        read: Effect.Effect<osis.PipelineEndpoint | undefined, E, R>,
      ): Effect.Effect<osis.PipelineEndpoint | undefined, E, R> =>
        Effect.repeat(read, {
          schedule: Schedule.max([
            Schedule.fixed("15 seconds"),
            Schedule.recurs(40),
          ]),
          until: (endpoint): boolean =>
            endpoint === undefined || endpoint.Status !== "CREATING",
        });

      return {
        stables: ["endpointId", "pipelineArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Every property is create-only.
          if (
            olds?.pipelineArn !== news.pipelineArn ||
            !jsonEquals(olds?.vpcOptions, news.vpcOptions)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ output }) {
          // The endpoint id is assigned by OSIS on create; without a
          // persisted id there is nothing deterministic to look up.
          if (output?.endpointId === undefined) return undefined;
          const endpoint = yield* findEndpoint(output.endpointId);
          if (endpoint === undefined) return undefined;
          // Endpoints are not taggable — ownership is implied by the
          // persisted create-assigned id.
          return yield* toAttrs(endpoint);
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const props = news!;

          // 1. Observe — the persisted id is a cache, not a guarantee.
          let observed =
            output?.endpointId !== undefined
              ? yield* findEndpoint(output.endpointId)
              : undefined;

          // 2. Ensure — create if missing (ids are server-assigned, so
          // there is no AlreadyExists race to tolerate).
          if (observed === undefined) {
            const created = yield* osis.createPipelineEndpoint({
              PipelineArn: props.pipelineArn,
              VpcOptions: {
                SubnetIds: props.vpcOptions.subnetIds,
                SecurityGroupIds: props.vpcOptions.securityGroupIds,
              },
            });
            if (created.EndpointId === undefined) {
              return yield* Effect.fail(
                new Error("OSIS createPipelineEndpoint returned no EndpointId"),
              );
            }
            observed = yield* findEndpoint(created.EndpointId);
          }

          // Wait (bounded) for the asynchronous create to settle; there is
          // no mutable aspect to sync — every property is create-only.
          if (observed?.Status === "CREATING" && observed.EndpointId) {
            observed = yield* waitForSettled(findEndpoint(observed.EndpointId));
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                "OSIS pipeline endpoint disappeared while waiting for create",
              ),
            );
          }
          if (observed.Status === "CREATE_FAILED") {
            return yield* Effect.fail(
              new PipelineEndpointCreateFailed({
                endpointId: observed.EndpointId ?? "",
                status: observed.Status,
              }),
            );
          }

          yield* session.note(observed.EndpointId ?? "");
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Observe first for idempotency — the delete error union carries
          // no typed not-found tag.
          const observed = yield* findEndpoint(output.endpointId);
          if (observed === undefined || observed.Status === "DELETING") {
            return;
          }
          yield* osis.deletePipelineEndpoint({
            EndpointId: output.endpointId,
          });
        }),

        list: () =>
          osis.listPipelineEndpoints.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.PipelineEndpoints ?? []),
            ),
            Effect.flatMap(
              Effect.forEach((endpoint) => toAttrs(endpoint), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );
