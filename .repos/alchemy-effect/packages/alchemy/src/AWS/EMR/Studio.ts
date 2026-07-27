import * as emr from "@distilled.cloud/aws/emr";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface StudioProps {
  /**
   * Descriptive name of the Studio. If omitted, a deterministic physical
   * name is generated. Updateable in place.
   */
  studioName?: string;
  /**
   * Authentication mode — `IAM` or `SSO` (IAM Identity Center). Changing the
   * mode replaces the Studio.
   * @default "IAM"
   */
  authMode?: "IAM" | "SSO";
  /**
   * VPC the Studio workspaces and notebooks connect to. Changing the VPC
   * replaces the Studio.
   */
  vpcId: string;
  /**
   * Subnets of the VPC the Studio can use (at most 5). Updateable in place
   * (subnets can be added, not removed).
   */
  subnetIds: string[];
  /**
   * ARN of the IAM service role the Studio assumes, trusting
   * `elasticmapreduce.amazonaws.com`. Changing the role replaces the Studio.
   */
  serviceRole: string;
  /**
   * ARN of the IAM user role Studio users assume (`SSO` auth mode only).
   * Changing the role replaces the Studio.
   */
  userRole?: string;
  /**
   * Security group for the Studio workspace (must allow outbound TCP 18888
   * to the engine security group and outbound HTTPS 443). Changing it
   * replaces the Studio.
   */
  workspaceSecurityGroupId: string;
  /**
   * Security group for the Studio engine (must allow inbound TCP 18888 from
   * the workspace security group). Changing it replaces the Studio.
   */
  engineSecurityGroupId: string;
  /**
   * S3 location that backs up Studio workspaces and notebooks, e.g.
   * `"s3://my-bucket/studio/"`. Updateable in place.
   */
  defaultS3Location: string;
  /**
   * Description of the Studio. Updateable in place.
   */
  description?: string;
  /**
   * Authentication endpoint of your identity provider (IAM federation only).
   * Changing it replaces the Studio.
   */
  idpAuthUrl?: string;
  /**
   * Name the IdP uses for its RelayState parameter (IAM federation only).
   * Changing it replaces the Studio.
   */
  idpRelayStateParameterName?: string;
  /**
   * Whether trusted identity propagation is enabled for the Studio.
   * Changing it replaces the Studio.
   */
  trustedIdentityPropagationEnabled?: boolean;
  /**
   * Whether IAM Identity Center user assignment is `REQUIRED` or `OPTIONAL`
   * (SSO auth mode only). Changing it replaces the Studio.
   */
  idcUserAssignment?: "REQUIRED" | "OPTIONAL";
  /**
   * ARN of the IAM Identity Center instance (SSO auth mode only). Changing
   * it replaces the Studio.
   */
  idcInstanceArn?: string;
  /**
   * KMS key ARN used to encrypt Studio workspace and notebook files.
   * Changing it replaces the Studio.
   */
  encryptionKeyArn?: string;
  /**
   * User-defined tags for the Studio.
   */
  tags?: Record<string, string>;
}

export interface Studio extends Resource<
  "AWS.EMR.Studio",
  StudioProps,
  {
    /** The ID of the Studio (e.g. `es-0123456789ABCDEFGHIJKLMNOP`). */
    studioId: string;
    /** The ARN of the Studio. */
    studioArn: string;
    /** The name of the Studio. */
    studioName: string;
    /** The unique access URL of the Studio. */
    url: string | undefined;
    /** The tags applied to the Studio. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon EMR Studio — a web-based IDE for notebooks and interactive
 * workloads that attaches to EMR clusters.
 *
 * A Studio itself is free; you pay for the clusters it attaches to. Each
 * Studio needs a VPC with subnets, a workspace and an engine security group,
 * an IAM service role, and an S3 backup location.
 * @resource
 * @section Creating a Studio
 * @example IAM-Authenticated Studio
 * ```typescript
 * const studio = yield* Studio("Notebooks", {
 *   authMode: "IAM",
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   serviceRole: serviceRole.roleArn,
 *   workspaceSecurityGroupId: workspaceSg.groupId,
 *   engineSecurityGroupId: engineSg.groupId,
 *   defaultS3Location: Output.interpolate`s3://${bucket.bucketName}/studio/`,
 * });
 * ```
 *
 * @example Studio with Description and Tags
 * ```typescript
 * const studio = yield* Studio("Notebooks", {
 *   authMode: "IAM",
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnetA.subnetId],
 *   serviceRole: serviceRole.roleArn,
 *   workspaceSecurityGroupId: workspaceSg.groupId,
 *   engineSecurityGroupId: engineSg.groupId,
 *   defaultS3Location: Output.interpolate`s3://${bucket.bucketName}/studio/`,
 *   description: "Data-science notebooks",
 *   tags: { team: "analytics" },
 * });
 * ```
 */
export const Studio = Resource<Studio>("AWS.EMR.Studio");

const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * A freshly created IAM service role (or its inline policy) takes a few
 * seconds to propagate (IAM eventual consistency); CreateStudio validates
 * both assumability and S3-location access at create time and surfaces that
 * window as the typed StudioServiceRoleNotAssumable /
 * StudioServiceRoleMissingS3Access tags. Bounded retry (~40s max) — a
 * genuinely misconfigured role still fails, just slower.
 *
 * NOTE: keep this helper at module scope with an EXPLICIT return annotation —
 * an inlined `Effect.retry` in provider lifecycle code leaves `Retry.Return`'s
 * conditional type unresolved in the provider's inferred layer type, which
 * TypeScript's declaration emit widens to an `unknown` R.
 */
const retryWhileRolePropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "StudioServiceRoleNotAssumable" ||
      e._tag === "StudioServiceRoleMissingS3Access",
    schedule: Schedule.max([Schedule.fixed("4 seconds"), Schedule.recurs(10)]),
  });

export const StudioProvider = () =>
  Provider.effect(
    Studio,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<StudioProps>) =>
        props.studioName
          ? Effect.succeed(props.studioName)
          : createPhysicalName({ id, maxLength: 80 });

      const readStudio = Effect.fn(function* (studioId: string) {
        const response = yield* emr
          .describeStudio({ StudioId: studioId })
          .pipe(
            Effect.catchTag("StudioNotFound", () => Effect.succeed(undefined)),
          );
        return response?.Studio;
      });

      // Studio names are not unique; the deterministic physical name is.
      // Used when state was lost and we only know the derived name.
      const findStudioByName = Effect.fn(function* (name: string) {
        const matches = yield* emr.listStudios.items({}).pipe(
          Stream.filter((summary) => summary.Name === name),
          Stream.take(1),
          Stream.runCollect,
        );
        const summary = Array.from(matches)[0];
        return summary?.StudioId
          ? yield* readStudio(summary.StudioId)
          : undefined;
      });

      const toAttrs = Effect.fn(function* (studio: emr.Studio) {
        if (!studio.StudioId || !studio.StudioArn || !studio.Name) {
          return yield* Effect.fail(
            new Error(`EMR Studio '${studio.StudioId}' is missing its ARN`),
          );
        }
        return {
          studioId: studio.StudioId,
          studioArn: studio.StudioArn,
          studioName: studio.Name,
          url: studio.Url,
          tags: toTagRecord(studio.Tags),
        };
      });

      return {
        stables: ["studioId", "studioArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news;
          const o = olds;
          if (n === undefined || o === undefined) return undefined;
          // Create-only properties force a replacement. (Name, description,
          // subnets, and the S3 location update in place.)
          if ((n.authMode ?? "IAM") !== (o.authMode ?? "IAM")) {
            return { action: "replace" } as const;
          }
          if (n.vpcId !== o.vpcId) {
            return { action: "replace" } as const;
          }
          if (n.serviceRole !== o.serviceRole) {
            return { action: "replace" } as const;
          }
          if ((n.userRole ?? undefined) !== (o.userRole ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (n.workspaceSecurityGroupId !== o.workspaceSecurityGroupId) {
            return { action: "replace" } as const;
          }
          if (n.engineSecurityGroupId !== o.engineSecurityGroupId) {
            return { action: "replace" } as const;
          }
          if ((n.idpAuthUrl ?? undefined) !== (o.idpAuthUrl ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (
            (n.idpRelayStateParameterName ?? undefined) !==
            (o.idpRelayStateParameterName ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (n.trustedIdentityPropagationEnabled ?? undefined) !==
            (o.trustedIdentityPropagationEnabled ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (n.idcUserAssignment ?? undefined) !==
            (o.idcUserAssignment ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (n.idcInstanceArn ?? undefined) !== (o.idcInstanceArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (n.encryptionKeyArn ?? undefined) !==
            (o.encryptionKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const studio = output?.studioId
            ? yield* readStudio(output.studioId)
            : yield* findStudioByName(yield* toName(id, olds ?? {}));
          if (!studio) return undefined;
          const attrs = yield* toAttrs(studio);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = yield* toName(id, props);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative; output is only an id
          //    cache.
          let observed = output?.studioId
            ? yield* readStudio(output.studioId)
            : yield* findStudioByName(name);

          // 2. Ensure — create if missing. Create errors (invalid security
          //    groups, role, subnets) propagate directly.
          if (observed === undefined) {
            const created = yield* retryWhileRolePropagates(
              emr.createStudio({
                Name: name,
                AuthMode: props.authMode ?? "IAM",
                VpcId: props.vpcId,
                SubnetIds: props.subnetIds,
                ServiceRole: props.serviceRole,
                UserRole: props.userRole,
                WorkspaceSecurityGroupId: props.workspaceSecurityGroupId,
                EngineSecurityGroupId: props.engineSecurityGroupId,
                DefaultS3Location: props.defaultS3Location,
                Description: props.description,
                IdpAuthUrl: props.idpAuthUrl,
                IdpRelayStateParameterName: props.idpRelayStateParameterName,
                TrustedIdentityPropagationEnabled:
                  props.trustedIdentityPropagationEnabled,
                IdcUserAssignment: props.idcUserAssignment,
                IdcInstanceArn: props.idcInstanceArn,
                EncryptionKeyArn: props.encryptionKeyArn,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            );
            if (!created.StudioId) {
              return yield* Effect.fail(
                new Error(`CreateStudio for '${name}' returned no StudioId`),
              );
            }
            observed = yield* readStudio(created.StudioId);
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `EMR Studio '${created.StudioId}' not visible after create`,
                ),
              );
            }
          }
          const studioId = observed.StudioId!;

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: emr.UpdateStudioInput = { StudioId: studioId };
          let mutated = false;
          if (observed.Name !== name) {
            update.Name = name;
            mutated = true;
          }
          if (
            props.description !== undefined &&
            props.description !== observed.Description
          ) {
            update.Description = props.description;
            mutated = true;
          }
          if (!sameStringSet(props.subnetIds, observed.SubnetIds)) {
            update.SubnetIds = props.subnetIds;
            mutated = true;
          }
          if (props.defaultS3Location !== observed.DefaultS3Location) {
            update.DefaultS3Location = props.defaultS3Location;
            mutated = true;
          }
          if (mutated) {
            yield* emr.updateStudio(update);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = toTagRecord(observed.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* emr.addTags({ ResourceId: studioId, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* emr.removeTags({ ResourceId: studioId, TagKeys: removed });
          }

          // 4. Return fresh attributes.
          const final = yield* readStudio(studioId);
          yield* session.note(studioId);
          return yield* toAttrs(final ?? observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* emr
            .deleteStudio({ StudioId: output.studioId })
            .pipe(Effect.catchTag("StudioNotFound", () => Effect.void));
        }),

        list: () =>
          emr.listStudios.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.StudioId ? [summary.StudioId] : [],
              ),
            ),
            Effect.flatMap(
              Effect.forEach((studioId) => readStudio(studioId), {
                concurrency: 4,
              }),
            ),
            Effect.map((studios) =>
              studios.filter(
                (studio): studio is emr.Studio => studio !== undefined,
              ),
            ),
            Effect.flatMap(
              Effect.forEach((studio) => toAttrs(studio), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
