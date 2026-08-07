import * as eks from "@distilled.cloud/aws/eks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface FargateProfileProps {
  /**
   * Name of the EKS cluster that owns this Fargate profile.
   */
  clusterName: Input<string>;
  /**
   * Name of the Fargate profile. If omitted, a unique name is generated.
   */
  fargateProfileName?: string;
  /**
   * ARN of the pod execution IAM role that Fargate pods assume. The role must
   * trust `eks-fargate-pods.amazonaws.com`. Changing this replaces the profile.
   */
  podExecutionRoleArn: Input<string>;
  /**
   * Selectors (namespace + optional labels) that decide which pods run on
   * Fargate. Changing this replaces the profile.
   */
  selectors: eks.FargateProfileSelector[];
  /**
   * Subnet IDs to run Fargate pods in. **Fargate pods require PRIVATE subnets
   * only** — a subnet that auto-assigns a public IP is rejected by EKS. Changing
   * this replaces the profile.
   */
  subnets?: Input<string>[];
  /**
   * User-defined tags to apply to the Fargate profile.
   */
  tags?: Record<string, string>;
}

export interface FargateProfile extends Resource<
  "AWS.EKS.FargateProfile",
  FargateProfileProps,
  {
    /** The name of the Fargate profile. */
    fargateProfileName: string;
    /** The ARN of the Fargate profile. */
    fargateProfileArn: string;
    /** The name of the EKS cluster the profile belongs to. */
    clusterName: string;
    /** The profile status (e.g. `CREATING`, `ACTIVE`). */
    status: eks.FargateProfileStatus;
    /** The ARN of the pod execution role used by pods matched by the profile. */
    podExecutionRoleArn: string;
    /** The IDs of the (private) subnets pods are launched into. */
    subnets: string[];
    /** The namespace/label selectors that route pods onto Fargate. */
    selectors: eks.FargateProfileSelector[];
    /** The tags applied to the Fargate profile. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon EKS Fargate profile — declares which pods (by namespace + labels)
 * run on AWS Fargate serverless compute instead of on EC2 nodes.
 *
 * Fargate profiles are immutable except for tags: any change to selectors, the
 * pod execution role, or subnets forces a replacement. Create and delete are
 * asynchronous (`CREATING` → `ACTIVE`, `DELETING` → gone, ~1–2 min each) and the
 * provider waits for the terminal state. EKS allows only one Fargate profile per
 * cluster to be creating or deleting at a time, so the provider retries the
 * `ResourceInUseException` that surfaces when a peer profile operation is in
 * flight.
 *
 * **Fargate pods must run in private subnets** — pass private subnet IDs only.
 * @resource
 * @section Creating Fargate Profiles
 * @example Run the `default` Namespace on Fargate
 * ```typescript
 * const profile = yield* FargateProfile("DefaultFargate", {
 *   clusterName: cluster.clusterName,
 *   podExecutionRoleArn: podRole.roleArn,
 *   subnets: network.privateSubnetIds,
 *   selectors: [{ namespace: "default" }],
 * });
 * ```
 *
 * @example Select Pods by Namespace and Labels
 * ```typescript
 * const profile = yield* FargateProfile("BatchFargate", {
 *   clusterName: cluster.clusterName,
 *   podExecutionRoleArn: podRole.roleArn,
 *   subnets: network.privateSubnetIds,
 *   selectors: [
 *     { namespace: "batch", labels: { compute: "fargate" } },
 *   ],
 * });
 * ```
 */
export const FargateProfile = Resource<FargateProfile>(
  "AWS.EKS.FargateProfile",
);

class FargateProfileNotReady extends Data.TaggedError(
  "EKS.FargateProfileNotReady",
)<{
  status: eks.FargateProfileStatus | undefined;
}> {}

class FargateProfileStillExists extends Data.TaggedError(
  "EKS.FargateProfileStillExists",
)<{}> {}

class FargateProfileBusy extends Data.TaggedError(
  "EKS.FargateProfileBusy",
)<{}> {}

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

// ~10 min at 5s spacing — Fargate profile transitions complete in 1–2 min.
const waitSchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(120),
]);

// One profile per cluster may be creating/deleting at a time; back off on the
// ResourceInUseException that peer operations raise (bounded).
const busySchedule = Schedule.max([
  Schedule.spaced("10 seconds"),
  Schedule.recurs(30),
]);

const mapFargateProfile = (
  profile: eks.FargateProfile,
  tags: Record<string, string>,
): FargateProfile["Attributes"] => ({
  fargateProfileName: profile.fargateProfileName!,
  fargateProfileArn: profile.fargateProfileArn!,
  clusterName: profile.clusterName!,
  status: profile.status ?? "CREATING",
  podExecutionRoleArn: profile.podExecutionRoleArn!,
  subnets: profile.subnets ?? [],
  selectors: profile.selectors ?? [],
  tags,
});

export const FargateProfileProvider = () =>
  Provider.effect(
    FargateProfile,
    Effect.gen(function* () {
      const toProfileName = (
        id: string,
        props: { fargateProfileName?: string } = {},
      ) =>
        props.fargateProfileName
          ? Effect.succeed(props.fargateProfileName)
          : createPhysicalName({ id, maxLength: 63 });

      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      const readProfile = Effect.fn(function* ({
        clusterName,
        fargateProfileName,
      }: {
        clusterName: string;
        fargateProfileName: string;
      }) {
        const described = yield* eks
          .describeFargateProfile({ clusterName, fargateProfileName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const profile = described?.fargateProfile;
        if (
          !profile?.fargateProfileArn ||
          !profile.fargateProfileName ||
          !profile.clusterName ||
          !profile.podExecutionRoleArn
        ) {
          return undefined;
        }
        return mapFargateProfile(profile, normalizeTags(profile.tags));
      });

      const waitForProfileActive = (
        clusterName: string,
        fargateProfileName: string,
      ) =>
        readProfile({ clusterName, fargateProfileName }).pipe(
          Effect.flatMap((state) => {
            if (!state) {
              return Effect.fail(
                new FargateProfileNotReady({ status: undefined }),
              );
            }
            if (state.status === "ACTIVE") {
              return Effect.succeed(state);
            }
            if (
              state.status === "CREATE_FAILED" ||
              state.status === "DELETE_FAILED"
            ) {
              return Effect.fail(
                new Error(
                  `EKS Fargate profile '${fargateProfileName}' entered ${state.status}`,
                ),
              );
            }
            return Effect.fail(
              new FargateProfileNotReady({ status: state.status }),
            );
          }),
          Effect.retry({
            while: (error) => error instanceof FargateProfileNotReady,
            schedule: waitSchedule,
          }),
        );

      const waitForProfileDeleted = (
        clusterName: string,
        fargateProfileName: string,
      ) =>
        readProfile({ clusterName, fargateProfileName }).pipe(
          Effect.flatMap((state) =>
            state
              ? Effect.fail(new FargateProfileStillExists())
              : Effect.succeed(undefined),
          ),
          Effect.retry({
            while: (error) => error instanceof FargateProfileStillExists,
            schedule: waitSchedule,
          }),
        );

      return {
        stables: ["fargateProfileArn", "fargateProfileName", "clusterName"],
        // Enumerate every Fargate profile across the account/region.
        // `listFargateProfiles` is cluster-scoped, so first enumerate all
        // clusters, list each cluster's profiles, then hydrate via
        // `describeFargateProfile`.
        list: () =>
          Effect.gen(function* () {
            const clusterNames = yield* eks.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusters ?? []),
              ),
            );

            const perCluster = yield* Effect.forEach(
              clusterNames,
              (clusterName) =>
                eks.listFargateProfiles.pages({ clusterName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap(
                      (page) => page.fargateProfileNames ?? [],
                    ),
                  ),
                  Effect.flatMap((names) =>
                    Effect.forEach(
                      names,
                      (fargateProfileName) =>
                        readProfile({ clusterName, fargateProfileName }),
                      { concurrency: 5 },
                    ),
                  ),
                ),
              { concurrency: 5 },
            );

            return perCluster
              .flat()
              .filter(
                (state): state is FargateProfile["Attributes"] =>
                  state !== undefined,
              );
          }),
        diff: Effect.fn(function* ({
          id,
          olds = {} as FargateProfileProps,
          news,
        }) {
          if (!isResolved(news)) return;
          if (
            (yield* toProfileName(id, olds)) !==
            (yield* toProfileName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }
          if (olds.podExecutionRoleArn !== news.podExecutionRoleArn) {
            return { action: "replace" } as const;
          }
          if (
            JSON.stringify(olds.subnets ?? []) !==
            JSON.stringify(news.subnets ?? [])
          ) {
            return { action: "replace" } as const;
          }
          if (
            JSON.stringify(olds.selectors ?? []) !==
            JSON.stringify(news.selectors ?? [])
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName = (output?.clusterName ??
            (olds?.clusterName as string | undefined)) as string | undefined;
          if (!clusterName) return undefined;
          const fargateProfileName =
            output?.fargateProfileName ??
            (yield* toProfileName(id, olds ?? {}));
          const state = yield* readProfile({ clusterName, fargateProfileName });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clusterName = news.clusterName as string;
          const fargateProfileName = yield* toProfileName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — cloud state is authoritative.
          let state = yield* readProfile({ clusterName, fargateProfileName });

          // Ensure — create if missing. A create raises ResourceInUseException
          // if another profile on the cluster is creating/deleting; back off
          // and retry. Tolerate a create race with a peer reconciler.
          if (!state) {
            yield* eks
              .createFargateProfile({
                clusterName,
                fargateProfileName,
                podExecutionRoleArn: news.podExecutionRoleArn as string,
                selectors: news.selectors,
                subnets: news.subnets as string[] | undefined,
                tags: desiredTags,
                clientRequestToken: yield* toClientRequestToken(id, "create"),
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () =>
                  Effect.fail(new FargateProfileBusy()),
                ),
                Effect.retry({
                  while: (error) => error instanceof FargateProfileBusy,
                  schedule: busySchedule,
                }),
                Effect.catchIf(
                  (error) => error instanceof FargateProfileBusy,
                  () => Effect.void,
                ),
              );

            yield* session.note(
              `Creating EKS Fargate profile ${fargateProfileName}...`,
            );
            state = yield* waitForProfileActive(
              clusterName,
              fargateProfileName,
            );
          }

          // Sync tags — the only mutable aspect. Diff observed cloud tags
          // against desired.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* eks.tagResource({
              resourceArn: state.fargateProfileArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: state.fargateProfileArn,
              tagKeys: removed,
            });
          }

          yield* session.note(state.fargateProfileArn);

          const final = yield* readProfile({ clusterName, fargateProfileName });
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `EKS Fargate profile '${fargateProfileName}' could not be read after reconcile`,
              ),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eks
            .deleteFargateProfile({
              clusterName: output.clusterName,
              fargateProfileName: output.fargateProfileName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // A concurrent profile create/delete on the cluster raises
              // ResourceInUseException — back off and retry the delete.
              Effect.catchTag("ResourceInUseException", () =>
                Effect.fail(new FargateProfileBusy()),
              ),
              Effect.retry({
                while: (error) => error instanceof FargateProfileBusy,
                schedule: busySchedule,
              }),
              Effect.catchIf(
                (error) => error instanceof FargateProfileBusy,
                () => Effect.void,
              ),
            );
          yield* waitForProfileDeleted(
            output.clusterName,
            output.fargateProfileName,
          );
        }),
      };
    }),
  );
