import * as redshiftserverless from "@distilled.cloud/aws/redshift-serverless";
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
import { readTags, syncTags, toWireTags } from "./internal.ts";

export interface WorkgroupProps {
  /**
   * Name of the workgroup. Must be 3-64 characters, lowercase letters,
   * numbers, and hyphens. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the workgroup.
   */
  workgroupName?: string;
  /**
   * Name of the namespace this workgroup provides compute for. Changing the
   * namespace replaces the workgroup.
   */
  namespaceName: string;
  /**
   * Base compute capacity in Redshift Processing Units (RPUs), 8-1024 in
   * multiples of 8. 8 RPU is the cheapest configuration.
   * @default 8
   */
  baseCapacity?: number;
  /**
   * Maximum RPUs the workgroup can burst to. Omit to disable the ceiling.
   */
  maxCapacity?: number;
  /**
   * Route all traffic through the VPC (enhanced VPC routing) instead of the
   * internet.
   * @default false
   */
  enhancedVpcRouting?: boolean;
  /**
   * Whether the workgroup is reachable from the public internet.
   * @default false
   */
  publiclyAccessible?: boolean;
  /**
   * VPC subnet IDs the workgroup runs in. Must span at least three
   * Availability Zones. Defaults to the account's default-VPC subnets.
   */
  subnetIds?: string[];
  /**
   * VPC security group IDs attached to the workgroup.
   */
  securityGroupIds?: string[];
  /**
   * Port the workgroup listens on.
   * @default 5439
   */
  port?: number;
  /**
   * Redshift configuration parameters (e.g. `max_query_execution_time`,
   * `enable_user_activity_logging`) as key/value pairs.
   */
  configParameters?: Record<string, string>;
  /**
   * User-defined tags for the workgroup.
   */
  tags?: Record<string, string>;
}

export interface Workgroup extends Resource<
  "AWS.RedshiftServerless.Workgroup",
  WorkgroupProps,
  {
    /**
     * Name of the workgroup.
     */
    workgroupName: string;
    /**
     * ARN of the workgroup.
     */
    workgroupArn: string;
    /**
     * Unique ID of the workgroup.
     */
    workgroupId: string;
    /**
     * Name of the namespace the workgroup computes against.
     */
    namespaceName: string;
    /**
     * Current workgroup status (e.g. `"AVAILABLE"`).
     */
    status: string;
    /**
     * DNS address of the workgroup endpoint (pgwire host).
     */
    endpointAddress: string | undefined;
    /**
     * Port of the workgroup endpoint (5439 by default).
     */
    endpointPort: number | undefined;
    /**
     * Whether the endpoint is reachable from the public internet.
     */
    publiclyAccessible: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Redshift Serverless workgroup — the compute half of a serverless
 * data warehouse.
 *
 * A workgroup provides on-demand compute (measured in RPUs) against a
 * {@link Namespace}'s data. Creating a workgroup is asynchronous and takes
 * roughly 2-5 minutes; the provider waits (bounded) for it to become
 * `AVAILABLE`. Because a running workgroup bills against its RPU floor, tear
 * it down promptly when you are done.
 *
 * @resource
 * @section Creating a Workgroup
 * @example Minimal (Cheapest) Workgroup
 * ```typescript
 * const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *   adminUsername: "admin",
 *   manageAdminPassword: true,
 * });
 * const workgroup = yield* RedshiftServerless.Workgroup("AnalyticsWg", {
 *   namespaceName: namespace.namespaceName,
 *   baseCapacity: 8,
 * });
 * // workgroup.endpointAddress -> "<wg>.<account>.<region>.redshift-serverless.amazonaws.com"
 * ```
 *
 * @section Networking
 * @example Publicly Accessible with Explicit Subnets
 * ```typescript
 * const workgroup = yield* RedshiftServerless.Workgroup("AnalyticsWg", {
 *   namespaceName: namespace.namespaceName,
 *   baseCapacity: 8,
 *   publiclyAccessible: true,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId, subnetC.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   enhancedVpcRouting: false,
 * });
 * ```
 */
export const Workgroup = Resource<Workgroup>(
  "AWS.RedshiftServerless.Workgroup",
);

class WorkgroupNotSettled extends Data.TaggedError("WorkgroupNotSettled")<{
  readonly workgroupName: string;
  readonly status: string;
}> {}

const statusIs = (status: string | undefined, expected: string): boolean =>
  status?.toUpperCase() === expected;

const sameStringSet = (a: string[], b: string[]): boolean => {
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
};

const toConfigList = (
  config: Record<string, string> | undefined,
): redshiftserverless.ConfigParameter[] | undefined =>
  config === undefined
    ? undefined
    : Object.entries(config).map(([parameterKey, parameterValue]) => ({
        parameterKey,
        parameterValue,
      }));

export const WorkgroupProvider = () =>
  Provider.effect(
    Workgroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<WorkgroupProps>) =>
        props.workgroupName
          ? Effect.succeed(props.workgroupName)
          : createPhysicalName({ id, maxLength: 64 });

      const readWorkgroup = Effect.fn(function* (name: string) {
        const response = yield* redshiftserverless
          .getWorkgroup({ workgroupName: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.workgroup;
      });

      // Workgroup create/update converge through CREATING/MODIFYING. Creation
      // takes ~2-5 min; budget ~8 min (96 * 5s).
      const waitForAvailable = Effect.fn(function* (name: string) {
        return yield* readWorkgroup(name).pipe(
          Effect.flatMap((wg) =>
            wg !== undefined && !statusIs(wg.status, "AVAILABLE")
              ? Effect.fail(
                  new WorkgroupNotSettled({
                    workgroupName: name,
                    status: wg.status ?? "UNKNOWN",
                  }),
                )
              : Effect.succeed(wg),
          ),
          Effect.retry({
            while: (e) => e instanceof WorkgroupNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(96),
            ]),
          }),
        );
      });

      const waitUntilGone = Effect.fn(function* (name: string) {
        yield* readWorkgroup(name).pipe(
          Effect.flatMap((wg) =>
            wg === undefined
              ? Effect.void
              : Effect.fail(
                  new WorkgroupNotSettled({
                    workgroupName: name,
                    status: wg.status ?? "DELETING",
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e instanceof WorkgroupNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(96),
            ]),
          }),
        );
      });

      const toAttrs = (wg: redshiftserverless.Workgroup) => ({
        workgroupName: wg.workgroupName!,
        workgroupArn: wg.workgroupArn!,
        workgroupId: wg.workgroupId!,
        namespaceName: wg.namespaceName!,
        status: wg.status ?? "UNKNOWN",
        endpointAddress: wg.endpoint?.address,
        endpointPort: wg.endpoint?.port,
        publiclyAccessible: wg.publiclyAccessible,
      });

      // Redshift Serverless rejects multi-parameter updates: "You can't
      // update multiple parameters in one request." Apply each drifted field
      // as its own updateWorkgroup call, waiting for AVAILABLE between them.
      const applyUpdate = Effect.fn(function* (
        name: string,
        patch: Omit<redshiftserverless.UpdateWorkgroupRequest, "workgroupName">,
      ) {
        yield* redshiftserverless.updateWorkgroup({
          workgroupName: name,
          ...patch,
        });
        return yield* waitForAvailable(name);
      });

      return {
        stables: ["workgroupName", "workgroupArn", "workgroupId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // A workgroup can't be reassigned to another namespace.
          if (
            (news?.namespaceName ?? undefined) !==
            (olds?.namespaceName ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.workgroupName ?? (yield* toName(id, olds ?? {}));
          const wg = yield* readWorkgroup(name);
          if (wg === undefined) return undefined;
          const attrs = toAttrs(wg);
          const tags = yield* readTags(attrs.workgroupArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.workgroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const baseCapacity = news.baseCapacity ?? 8;

          // 1. Observe.
          let observed = yield* readWorkgroup(name);

          // 2. Ensure — create if missing; tolerate a concurrent create.
          if (observed === undefined) {
            const created = yield* redshiftserverless
              .createWorkgroup({
                workgroupName: name,
                namespaceName: news.namespaceName,
                baseCapacity,
                maxCapacity: news.maxCapacity,
                enhancedVpcRouting: news.enhancedVpcRouting,
                publiclyAccessible: news.publiclyAccessible,
                subnetIds: news.subnetIds,
                securityGroupIds: news.securityGroupIds,
                port: news.port,
                configParameters: toConfigList(news.configParameters),
                tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.workgroup),
                Effect.catchTag("ConflictException", () =>
                  redshiftserverless
                    .getWorkgroup({ workgroupName: name })
                    .pipe(Effect.map((r) => r.workgroup)),
                ),
              );
            observed = created;
          }

          const settled = yield* waitForAvailable(name);
          if (settled !== undefined) observed = settled;
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `Redshift workgroup '${name}' disappeared while reconciling`,
              ),
            );
          }

          // 3. Sync — one updateWorkgroup per drifted field (multi-field
          // updates are rejected). Only mutate fields the user specified.
          if (
            news.baseCapacity !== undefined &&
            observed.baseCapacity !== baseCapacity
          ) {
            observed = (yield* applyUpdate(name, { baseCapacity })) ?? observed;
          }
          if (
            news.enhancedVpcRouting !== undefined &&
            observed.enhancedVpcRouting !== news.enhancedVpcRouting
          ) {
            observed =
              (yield* applyUpdate(name, {
                enhancedVpcRouting: news.enhancedVpcRouting,
              })) ?? observed;
          }
          if (
            news.publiclyAccessible !== undefined &&
            observed.publiclyAccessible !== news.publiclyAccessible
          ) {
            observed =
              (yield* applyUpdate(name, {
                publiclyAccessible: news.publiclyAccessible,
              })) ?? observed;
          }
          if (news.port !== undefined && observed.port !== news.port) {
            observed =
              (yield* applyUpdate(name, { port: news.port })) ?? observed;
          }
          if (
            news.securityGroupIds !== undefined &&
            !sameStringSet(
              observed.securityGroupIds ?? [],
              news.securityGroupIds,
            )
          ) {
            observed =
              (yield* applyUpdate(name, {
                securityGroupIds: news.securityGroupIds,
              })) ?? observed;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(observed.workgroupArn!, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* redshiftserverless
            .deleteWorkgroup({ workgroupName: output.workgroupName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // A concurrent modification may still be settling — retry.
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
              Effect.catchTag("ConflictException", () => Effect.void),
            );
          yield* waitUntilGone(output.workgroupName);
        }),

        list: () =>
          redshiftserverless.listWorkgroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.workgroups ?? [])
                .flatMap((wg) =>
                  wg.workgroupName !== undefined &&
                  wg.workgroupArn !== undefined &&
                  wg.workgroupId !== undefined &&
                  wg.namespaceName !== undefined
                    ? [
                        {
                          workgroupName: wg.workgroupName,
                          workgroupArn: wg.workgroupArn,
                          workgroupId: wg.workgroupId,
                          namespaceName: wg.namespaceName,
                          status: wg.status ?? "UNKNOWN",
                          endpointAddress: wg.endpoint?.address,
                          endpointPort: wg.endpoint?.port,
                          publiclyAccessible: wg.publiclyAccessible,
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
