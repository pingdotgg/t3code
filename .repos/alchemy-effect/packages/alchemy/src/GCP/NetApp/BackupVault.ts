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
  fingerprint,
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

export type BackupRetentionPolicy = {
  /**
   * Minimum retention duration in days for backups in the vault.
   */
  backupMinimumEnforcedRetentionDays?: number;
  /**
   * Whether daily backups are immutable.
   */
  dailyBackupImmutable?: boolean;
  /**
   * Whether weekly backups are immutable.
   */
  weeklyBackupImmutable?: boolean;
  /**
   * Whether monthly backups are immutable.
   */
  monthlyBackupImmutable?: boolean;
  /**
   * Whether manual backups are immutable.
   */
  manualBackupImmutable?: boolean;
};

export type BackupVaultProps = {
  /**
   * Backup vault id (the `{backupVault}` segment of
   * `projects/{project}/locations/{location}/backupVaults/{backupVault}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the vault.
   */
  backupVaultId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the vault. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Vault type. Immutable — changing it replaces the vault.
   * @default "IN_REGION"
   */
  backupVaultType?: netapp.BackupVaultBackupVaultTypeEnum | (string & {});
  /**
   * Region that stores backups for a cross-region vault. Full location
   * name or id. Immutable — changing it replaces the vault.
   */
  backupRegion?: string;
  /**
   * KMS config used to encrypt backups. Full name or id. Immutable —
   * changing it replaces the vault.
   */
  kmsConfig?: string;
  /**
   * Backup retention policy. At least one immutable flag must be true
   * when the policy is set.
   */
  backupRetentionPolicy?: BackupRetentionPolicy;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupVault = Resource<
  "GCP.NetApp.BackupVault",
  BackupVaultProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup vault id (last path segment). */
    backupVaultId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Vault type. */
    backupVaultType: string | undefined;
    /** Backup region. */
    backupRegion: string | undefined;
    /** Source region. */
    sourceRegion: string | undefined;
    /** Source vault name. */
    sourceBackupVault: string | undefined;
    /** Destination vault name. */
    destinationBackupVault: string | undefined;
    /** KMS config name. */
    kmsConfig: string | undefined;
    /** Crypto key version used to encrypt backups. */
    backupsCryptoKeyVersion: string | undefined;
    /** Encryption state of CMEK backups. */
    encryptionState: string | undefined;
    /** Retention policy. */
    backupRetentionPolicy: BackupRetentionPolicy | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes backup vault that stores volume backups.
 *
 * Changing `backupVaultId`, `location`, `backupVaultType`, `backupRegion`,
 * or `kmsConfig` replaces the vault. Description, labels, and retention
 * policy update in place.
 *
 * ### Creating a Backup Vault
 * **Example:** Generated name
 * ```typescript
 * const vault = yield* GCP.NetApp.BackupVault("Vault", {});
 * ```
 *
 * **Example:** Explicit id and description
 * ```typescript
 * const vault = yield* GCP.NetApp.BackupVault("Vault", {
 *   backupVaultId: "app-backups",
 *   description: "nightly backups",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup Vault
 * **Example:** Description and labels
 * ```typescript
 * const vault = yield* GCP.NetApp.BackupVault("Vault", {
 *   description: "nightly backups v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const BackupVault = Resource<BackupVault>("GCP.NetApp.BackupVault");

const resourceName = (
  project: string,
  location: string,
  backupVaultId: string,
) => `projects/${project}/locations/${location}/backupVaults/${backupVaultId}`;

const toRetention = (
  policy: netapp.BackupRetentionPolicy | undefined,
): BackupRetentionPolicy | undefined =>
  policy === undefined
    ? undefined
    : {
        backupMinimumEnforcedRetentionDays:
          policy.backupMinimumEnforcedRetentionDays,
        dailyBackupImmutable: policy.dailyBackupImmutable,
        weeklyBackupImmutable: policy.weeklyBackupImmutable,
        monthlyBackupImmutable: policy.monthlyBackupImmutable,
        manualBackupImmutable: policy.manualBackupImmutable,
      };

const toAttrs = (item: netapp.BackupVault, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backupVaults", region);
  return {
    name,
    backupVaultId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    backupVaultType: item.backupVaultType,
    backupRegion: item.backupRegion,
    sourceRegion: item.sourceRegion,
    sourceBackupVault: item.sourceBackupVault,
    destinationBackupVault: item.destinationBackupVault,
    kmsConfig: item.kmsConfig,
    backupsCryptoKeyVersion: item.backupsCryptoKeyVersion,
    encryptionState: item.encryptionState,
    backupRetentionPolicy: toRetention(item.backupRetentionPolicy),
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsBackupVaults({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsBackupVaults.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backupVaults,
      (item) => item.labels,
    ),
  );

export const BackupVaultProvider = () =>
  Provider.succeed(BackupVault, {
    stables: ["name", "backupVaultId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.backupVaultType ?? output?.backupVaultType;
      const previousRegion = olds?.backupRegion ?? output?.backupRegion;
      const previousKms = olds?.kmsConfig ?? output?.kmsConfig;
      return replaceOnIdentity({
        previousId: olds?.backupVaultId ?? output?.backupVaultId,
        nextId:
          news.backupVaultId ?? olds?.backupVaultId ?? output?.backupVaultId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined &&
            news.backupVaultType !== undefined &&
            news.backupVaultType !== previousType) ||
          (previousRegion !== undefined &&
            news.backupRegion !== undefined &&
            news.backupRegion !== previousRegion) ||
          (previousKms !== undefined &&
            news.kmsConfig !== undefined &&
            news.kmsConfig !== previousKms),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupVaultId = yield* toPhysicalId(
        id,
        olds?.backupVaultId,
        output?.backupVaultId,
        "backupvault",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, backupVaultId);
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
      const backupVaultId = yield* toPhysicalId(
        id,
        news.backupVaultId,
        output?.backupVaultId,
        "backupvault",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backupVaultId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const backupRegion =
        news.backupRegion === undefined
          ? undefined
          : news.backupRegion.includes("/")
            ? news.backupRegion
            : parentOf(env.project, news.backupRegion);
      const kmsConfig =
        news.kmsConfig === undefined
          ? undefined
          : expandParent(news.kmsConfig, env.project, location, "kmsConfigs");

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsBackupVaults({
            parent: parentOf(env.project, location),
            backupVaultId,
            body: {
              backupVaultType: news.backupVaultType,
              backupRegion,
              kmsConfig,
              backupRetentionPolicy: news.backupRetentionPolicy,
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
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        fingerprint(toRetention(current.backupRetentionPolicy)) !==
          fingerprint(news.backupRetentionPolicy) && "backupRetentionPolicy",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsBackupVaults({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            backupRetentionPolicy: news.backupRetentionPolicy,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsBackupVaults({ name: output.name })
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
