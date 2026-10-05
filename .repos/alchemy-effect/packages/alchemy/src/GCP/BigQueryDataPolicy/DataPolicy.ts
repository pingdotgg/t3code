import * as bqdp from "@distilled.cloud/gcp/bigquerydatapolicy_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  LIST_LOCATIONS,
  compact,
  hasOwnershipMarker,
  lastSegment,
  normalizeLocation,
  normalizePolicyType,
  ownedByAlchemy,
  parentOf,
  parseName,
  resourceNameOf,
  sameJson,
  sameStringList,
  sameText,
  sortedStrings,
  toDataPolicyId,
  updateMaskOf,
} from "./internal.ts";

export type DataPolicyType = bqdp.DataPolicyDataPolicyTypeEnum | (string & {});

export type DataMaskingPolicyPredefinedExpression =
  | bqdp.DataMaskingPolicyPredefinedExpressionEnum
  | (string & {});

export type DataMaskingPolicy = {
  /**
   * Predefined masking expression (`SHA256`, `ALWAYS_NULL`,
   * `DEFAULT_MASKING_VALUE`, `LAST_FOUR_CHARACTERS`,
   * `FIRST_FOUR_CHARACTERS`, `EMAIL_MASK`, `DATE_YEAR_MASK`,
   * `RANDOM_HASH`). Mutually exclusive with `routine`.
   */
  predefinedExpression?: DataMaskingPolicyPredefinedExpression;
  /**
   * BigQuery routine that implements a custom masking function, as
   * `projects/{project}/datasets/{dataset}/routines/{routine}`. Mutually
   * exclusive with `predefinedExpression`.
   */
  routine?: string;
};

export type DataGovernanceTag = {
  /**
   * Namespaced tag key (`parent-id/pii`). Tag keys are globally unique
   * Resource Manager keys.
   */
  key?: string;
  /**
   * Short tag value (`sensitive`).
   */
  value?: string;
};

export type DataPolicyProps = {
  /**
   * Data policy id (the `{dataPolicy}` segment of
   * `projects/{project}/locations/{location}/dataPolicies/{dataPolicy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Letters, digits, and underscores; max 200 characters.
   * Data policies have no labels field, so Alchemy stamps ownership into
   * this id (`alch___…`) for `list` / nuke. Immutable — changing it
   * replaces the policy.
   */
  dataPolicyId?: string;
  /**
   * BigQuery location (`us-central1`, `US`, `EU`, …). Immutable —
   * changing it replaces the policy. Multi-regions `US` and `EU` stay
   * uppercase; regional ids are lowercased (`US-CENTRAL1` becomes
   * `us-central1`).
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Type of data policy. `COLUMN_LEVEL_SECURITY_POLICY` is deprecated in
   * the v2 API (GET/LIST of v1 policies only).
   * @default "RAW_DATA_ACCESS_POLICY"
   */
  dataPolicyType?: DataPolicyType;
  /**
   * Masking rule. Required when `dataPolicyType` is
   * `DATA_MASKING_POLICY`.
   */
  dataMaskingPolicy?: DataMaskingPolicy;
  /**
   * IAM V2 principals with fine-grained access to the governed data
   * (`principal://goog/subject/user@example.com`). V2 policies only.
   */
  grantees?: string[];
  /**
   * Resource Manager data-governance tag bound to this policy.
   */
  dataGovernanceTag?: DataGovernanceTag;
};

export type DataPolicy = Resource<
  "GCP.BigQueryDataPolicy.DataPolicy",
  DataPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/dataPolicies/{dataPolicy}`. */
    name: string;
    /** Data policy id (last path segment), including the Alchemy prefix. */
    dataPolicyId: string;
    /** Project id used when the policy was reconciled. */
    project: string;
    /** Location id (`us-central1`, `US`, …). */
    location: string;
    /** Policy type. */
    dataPolicyType: string | undefined;
    /** Masking rule, if this is a data-masking policy. */
    dataMaskingPolicy: DataMaskingPolicy | undefined;
    /** Fine-grained access principals. */
    grantees: string[];
    /** Bound data-governance tag, if any. */
    dataGovernanceTag: DataGovernanceTag | undefined;
    /** Policy-tag resource name (v1 policies only). */
    policyTag: string | undefined;
    /** Server-reported policy version (`V1`, `V2`). */
    version: string | undefined;
    /** Server etag used for concurrent updates. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery Data Policy (v2) — raw-data access or column data masking.
 *
 * Data policies have no labels, so Alchemy stamps ownership into the
 * policy id (`alch___…`) so `list` / `pnpm nuke:gcp` can find them.
 * `dataPolicyId` and `location` are identity — changing either replaces
 * the policy. Type, masking rule, grantees, and the data-governance tag
 * update in place. Patches send the observed etag.
 *
 * ### Creating a Data Policy
 * **Example:** Raw-data access
 * ```typescript
 * const policy = yield* GCP.BigQueryDataPolicy.DataPolicy("Raw", {
 *   dataPolicyType: "RAW_DATA_ACCESS_POLICY",
 * });
 * ```
 *
 * **Example:** SHA256 masking
 * ```typescript
 * const policy = yield* GCP.BigQueryDataPolicy.DataPolicy("Mask", {
 *   location: "us-central1",
 *   dataPolicyType: "DATA_MASKING_POLICY",
 *   dataMaskingPolicy: { predefinedExpression: "SHA256" },
 * });
 * ```
 *
 * ### Updating a Data Policy
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Change the masking expression
 * ```typescript
 * const policy = yield* GCP.BigQueryDataPolicy.DataPolicy("Mask", {
 *   location: "us-central1",
 *   dataPolicyType: "DATA_MASKING_POLICY",
 *   dataMaskingPolicy: { predefinedExpression: "ALWAYS_NULL" },
 * });
 * ```
 *
 * @resource
 * @category BigQueryDataPolicy
 */
export const DataPolicy = Resource<DataPolicy>(
  "GCP.BigQueryDataPolicy.DataPolicy",
);

export class DataPolicyNotResolved extends Data.TaggedError(
  "GCP.BigQueryDataPolicy.DataPolicyNotResolved",
)<{
  name: string;
}> {}

const toMasking = (
  policy: bqdp.DataMaskingPolicy | undefined,
): DataMaskingPolicy | undefined => {
  if (policy === undefined) return undefined;
  const next = compact({
    predefinedExpression: policy.predefinedExpression,
    routine: policy.routine,
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

const toGovernanceTag = (
  tag: bqdp.DataGovernanceTag | undefined,
): DataGovernanceTag | undefined => {
  if (tag === undefined) return undefined;
  const next = compact({ key: tag.key, value: tag.value });
  return Object.keys(next).length > 0 ? next : undefined;
};

const toAttrs = (policy: bqdp.DataPolicy, project: string, region: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, project, region);
  return {
    name,
    dataPolicyId: policy.dataPolicyId ?? parsed.dataPolicyId,
    project,
    location: parsed.location,
    dataPolicyType: policy.dataPolicyType,
    dataMaskingPolicy: toMasking(policy.dataMaskingPolicy),
    grantees: sortedStrings(policy.grantees),
    dataGovernanceTag: toGovernanceTag(policy.dataGovernanceTag),
    policyTag: policy.policyTag,
    version: policy.version,
    etag: policy.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : bqdp
        .getProjectsLocationsDataPolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (project: string, location: string) =>
  bqdp.listProjectsLocationsDataPolicies
    .pages({
      parent: parentOf(project, location),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.dataPolicies ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as bqdp.DataPolicy[]),
      ),
    );

const findOwned = (
  items: readonly bqdp.DataPolicy[],
  id: string,
  name?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const match = items.find((item) => item.name === name);
      if (match !== undefined) return match;
    }
    for (const item of items) {
      const resourceId = item.dataPolicyId ?? lastSegment(item.name ?? "");
      if (yield* ownedByAlchemy(id, resourceId)) return item;
    }
    return undefined;
  });

const observe = (
  id: string,
  name: string | undefined,
  project: string,
  location: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    const items = yield* listAt(project, location);
    return yield* findOwned(items, id, name);
  });

const toCreateBody = (news: DataPolicyProps, dataPolicyType: string) =>
  compact({
    dataPolicyType,
    dataMaskingPolicy: news.dataMaskingPolicy,
    grantees: news.grantees,
    dataGovernanceTag: news.dataGovernanceTag,
  });

const patchPolicy = (name: string, updateMask: string, body: bqdp.DataPolicy) =>
  Effect.gen(function* () {
    const latest = yield* getByName(name);
    if (latest === undefined) {
      return yield* new DataPolicyNotResolved({ name });
    }
    return yield* bqdp.patchProjectsLocationsDataPolicies({
      name,
      updateMask,
      body: compact({
        ...body,
        etag: latest.etag,
      }),
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const DataPolicyProvider = () =>
  Provider.succeed(DataPolicy, {
    stables: ["name", "dataPolicyId", "project", "location"],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.dataPolicyId ?? output?.dataPolicyId;
      const nextId = yield* toDataPolicyId(id, news.dataPolicyId, previousId);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      if (
        (previousId === undefined || nextId === previousId) &&
        previousLocation === nextLocation
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: false,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataPolicyId = yield* toDataPolicyId(
        id,
        olds?.dataPolicyId,
        output?.dataPolicyId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceNameOf(env.project, location, dataPolicyId);
      const existing = yield* observe(id, name, env.project, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const resourceId =
        existing.dataPolicyId ?? lastSegment(existing.name ?? "");
      return (yield* ownedByAlchemy(id, resourceId)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          Array.from(new Set<string>([...LIST_LOCATIONS, env.region])),
          (location) => listAt(env.project, location),
          { concurrency: 4 },
        );
        const byName = new Map<string, ReturnType<typeof toAttrs>>();
        for (const item of pages.flat()) {
          const resourceId = item.dataPolicyId ?? lastSegment(item.name ?? "");
          if (!hasOwnershipMarker(resourceId)) continue;
          const attrs = toAttrs(item, env.project, env.region);
          if (attrs.name.length > 0) byName.set(attrs.name, attrs);
        }
        return Array.from(byName.values());
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataPolicyId = yield* toDataPolicyId(
        id,
        news.dataPolicyId,
        output?.dataPolicyId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = parentOf(env.project, location);
      const name =
        output?.name ?? resourceNameOf(env.project, location, dataPolicyId);
      const dataPolicyType = normalizePolicyType(
        news.dataPolicyType ?? output?.dataPolicyType,
      );

      let current = yield* observe(id, name, env.project, location);

      if (current === undefined) {
        const created = yield* bqdp
          .createProjectsLocationsDataPolicies({
            parent,
            body: {
              dataPolicyId,
              dataPolicy: toCreateBody(news, dataPolicyType),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              observe(id, name, env.project, location),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataPolicyNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const desiredType = normalizePolicyType(
        news.dataPolicyType ?? current.dataPolicyType,
      );
      const observedType = normalizePolicyType(current.dataPolicyType);
      const typeChanged = !sameText(observedType, desiredType);
      const maskingChanged =
        news.dataMaskingPolicy !== undefined &&
        !sameJson(toMasking(current.dataMaskingPolicy), news.dataMaskingPolicy);
      const granteesChanged =
        news.grantees !== undefined &&
        !sameStringList(current.grantees, news.grantees);
      const tagChanged =
        news.dataGovernanceTag !== undefined &&
        !sameJson(
          toGovernanceTag(current.dataGovernanceTag),
          news.dataGovernanceTag,
        );

      const updateMask = updateMaskOf(
        typeChanged ? "dataPolicyType" : undefined,
        maskingChanged ? "dataMaskingPolicy" : undefined,
        granteesChanged ? "grantees" : undefined,
        tagChanged ? "dataGovernanceTag" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* patchPolicy(
          currentName,
          updateMask,
          compact({
            dataPolicyType: typeChanged ? desiredType : undefined,
            dataMaskingPolicy: maskingChanged
              ? news.dataMaskingPolicy
              : undefined,
            grantees: granteesChanged ? news.grantees : undefined,
            dataGovernanceTag: tagChanged ? news.dataGovernanceTag : undefined,
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bqdp
        .deleteProjectsLocationsDataPolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
