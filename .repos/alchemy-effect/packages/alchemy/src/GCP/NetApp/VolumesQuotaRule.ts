import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  fieldMask,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_TYPE: netapp.QuotaRuleTypeEnum = "DEFAULT_USER_QUOTA";
const DEFAULT_DISK_LIMIT_MIB = 1024;

export type VolumesQuotaRuleProps = {
  /**
   * Parent volume. Full name
   * `projects/{project}/locations/{location}/volumes/{volume}` or the
   * volume id (combined with `location`). Immutable — changing it
   * replaces the rule.
   */
  volume: string;
  /**
   * Region used when `volume` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Quota rule id (the `{quotaRule}` segment). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the rule.
   */
  quotaRuleId?: string;
  /**
   * Quota type. Immutable — changing it replaces the rule.
   * @default "DEFAULT_USER_QUOTA"
   */
  type?: netapp.QuotaRuleTypeEnum | (string & {});
  /**
   * Maximum disk space in MiB.
   * @default 1024
   */
  diskLimitMib?: number;
  /**
   * Unix UID/GID, Windows SID, or omitted for a default quota.
   * Immutable — changing it replaces the rule.
   */
  target?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type VolumesQuotaRule = Resource<
  "GCP.NetApp.VolumesQuotaRule",
  VolumesQuotaRuleProps,
  {
    /** Full resource name. */
    name: string;
    /** Quota rule id (last path segment). */
    quotaRuleId: string;
    /** Parent volume name. */
    volume: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Quota type. */
    type: string | undefined;
    /** Disk limit in MiB. */
    diskLimitMib: number | undefined;
    /** Target user or group. */
    target: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** State details. */
    stateDetails: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes quota rule that caps disk usage for a user or
 * group on a volume.
 *
 * Changing `quotaRuleId`, `volume`, `location`, `type`, or `target`
 * replaces the rule. Disk limit, description, and labels update in place.
 *
 * ### Creating a Quota Rule
 * **Example:** Default user quota
 * ```typescript
 * const rule = yield* GCP.NetApp.VolumesQuotaRule("DefaultUser", {
 *   volume: volume.name,
 *   type: "DEFAULT_USER_QUOTA",
 *   diskLimitMib: 1024,
 * });
 * ```
 *
 * **Example:** Individual user quota
 * ```typescript
 * const rule = yield* GCP.NetApp.VolumesQuotaRule("Alice", {
 *   volume: volume.name,
 *   type: "INDIVIDUAL_USER_QUOTA",
 *   target: "1001",
 *   diskLimitMib: 2048,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Quota Rule
 * **Example:** Disk limit and labels
 * ```typescript
 * const rule = yield* GCP.NetApp.VolumesQuotaRule("DefaultUser", {
 *   volume: volume.name,
 *   diskLimitMib: 4096,
 *   description: "default user v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const VolumesQuotaRule = Resource<VolumesQuotaRule>(
  "GCP.NetApp.VolumesQuotaRule",
);

const resourceName = (volume: string, quotaRuleId: string) =>
  `${volume}/quotaRules/${quotaRuleId}`;

const toAttrs = (item: netapp.QuotaRule, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "quotaRules", region);
  return {
    name,
    quotaRuleId: parsed.id,
    volume: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type,
    diskLimitMib: item.diskLimitMib,
    target: item.target,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateDetails: item.stateDetails,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsVolumesQuotaRules({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "volumes/-", (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsVolumesQuotaRules.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.quotaRules,
      (item) => item.labels,
    ),
  );

export const VolumesQuotaRuleProvider = () =>
  Provider.succeed(VolumesQuotaRule, {
    stables: [
      "name",
      "quotaRuleId",
      "volume",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type;
      const previousTarget = olds?.target ?? output?.target;
      const nextType = news.type ?? DEFAULT_TYPE;
      return replaceOnIdentity({
        previousId: olds?.quotaRuleId ?? output?.quotaRuleId,
        nextId: news.quotaRuleId ?? olds?.quotaRuleId ?? output?.quotaRuleId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.volume ?? output?.volume,
        nextParent: news.volume,
        extra:
          (previousType !== undefined && nextType !== previousType) ||
          (previousTarget ?? "") !== (news.target ?? previousTarget ?? ""),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const quotaRuleId = yield* toPhysicalId(
        id,
        olds?.quotaRuleId,
        output?.quotaRuleId,
        "quotarule",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parent = olds?.volume ?? output?.volume;
      // A row whose parent never resolved (failed create) has nothing to read.
      if (output?.name === undefined && !parent) return undefined;
      const volume = expandParent(
        parent ?? "",
        env.project,
        location,
        "volumes",
      );
      const name = output?.name ?? resourceName(volume, quotaRuleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const quotaRuleId = yield* toPhysicalId(
        id,
        news.quotaRuleId,
        output?.quotaRuleId,
        "quotarule",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const volume = expandParent(
        news.volume,
        env.project,
        location,
        "volumes",
      );
      const name = resourceName(volume, quotaRuleId);
      const type = news.type ?? DEFAULT_TYPE;
      const diskLimitMib = news.diskLimitMib ?? DEFAULT_DISK_LIMIT_MIB;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsVolumesQuotaRules({
            parent: volume,
            quotaRuleId,
            body: {
              type,
              diskLimitMib,
              target: news.target,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        (item) => item.stateDetails,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        (current.diskLimitMib ?? DEFAULT_DISK_LIMIT_MIB) !== diskLimitMib &&
          "diskLimitMib",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsVolumesQuotaRules(
          {
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              diskLimitMib,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsVolumesQuotaRules({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
