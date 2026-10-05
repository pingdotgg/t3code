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
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
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

export type KmsConfigProps = {
  /**
   * KMS config id (the `{kmsConfig}` segment of
   * `projects/{project}/locations/{location}/kmsConfigs/{kmsConfig}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the config.
   */
  kmsConfigId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the config. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Customer-managed crypto key. Format
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Immutable — changing it replaces the config.
   */
  cryptoKeyName: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type KmsConfig = Resource<
  "GCP.NetApp.KmsConfig",
  KmsConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** KMS config id (last path segment). */
    kmsConfigId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Customer-managed crypto key name. */
    cryptoKeyName: string | undefined;
    /** Service account that must be granted access to the key. */
    serviceAccount: string | undefined;
    /** Instructions for granting key access. */
    instructions: string | undefined;
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
 * A Cloud NetApp Volumes CMEK configuration that encrypts volumes with a
 * customer-managed Cloud KMS key.
 *
 * Changing `kmsConfigId`, `location`, or `cryptoKeyName` replaces the
 * config. Description and labels update in place.
 *
 * ### Creating a KMS Config
 * **Example:** Generated name
 * ```typescript
 * const kms = yield* GCP.NetApp.KmsConfig("Cmek", {
 *   cryptoKeyName: key.name,
 * });
 * ```
 *
 * **Example:** Explicit id and description
 * ```typescript
 * const kms = yield* GCP.NetApp.KmsConfig("Cmek", {
 *   kmsConfigId: "app-cmek",
 *   cryptoKeyName: key.name,
 *   description: "volume encryption",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a KMS Config
 * **Example:** Description and labels
 * ```typescript
 * const kms = yield* GCP.NetApp.KmsConfig("Cmek", {
 *   cryptoKeyName: key.name,
 *   description: "volume encryption v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const KmsConfig = Resource<KmsConfig>("GCP.NetApp.KmsConfig");

const resourceName = (project: string, location: string, kmsConfigId: string) =>
  `projects/${project}/locations/${location}/kmsConfigs/${kmsConfigId}`;

const toAttrs = (item: netapp.KmsConfig, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "kmsConfigs", region);
  return {
    name,
    kmsConfigId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    cryptoKeyName: item.cryptoKeyName,
    serviceAccount: item.serviceAccount,
    instructions: item.instructions,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateDetails: item.stateDetails,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsKmsConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsKmsConfigs.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.kmsConfigs,
      (item) => item.labels,
    ),
  );

export const KmsConfigProvider = () =>
  Provider.succeed(KmsConfig, {
    stables: ["name", "kmsConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKey = olds?.cryptoKeyName ?? output?.cryptoKeyName;
      return replaceOnIdentity({
        previousId: olds?.kmsConfigId ?? output?.kmsConfigId,
        nextId: news.kmsConfigId ?? olds?.kmsConfigId ?? output?.kmsConfigId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: previousKey !== undefined && news.cryptoKeyName !== previousKey,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const kmsConfigId = yield* toPhysicalId(
        id,
        olds?.kmsConfigId,
        output?.kmsConfigId,
        "kmsconfig",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, kmsConfigId);
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
      const kmsConfigId = yield* toPhysicalId(
        id,
        news.kmsConfigId,
        output?.kmsConfigId,
        "kmsconfig",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, kmsConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsKmsConfigs({
            parent: parentOf(env.project, location),
            kmsConfigId,
            body: {
              cryptoKeyName: news.cryptoKeyName,
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
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsKmsConfigs({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
          },
        });
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
        .deleteProjectsLocationsKmsConfigs({ name: output.name })
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
