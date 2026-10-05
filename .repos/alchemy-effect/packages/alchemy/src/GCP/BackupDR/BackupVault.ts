import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
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
  DEFAULT_RETENTION,
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type EncryptionConfig = {
  /**
   * Cloud KMS key used to encrypt backups in this vault. Must be in the
   * same region. Format:
   * `projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}`.
   * Immutable after create.
   */
  kmsKeyName?: string;
};

export type BackupVaultProps = {
  /**
   * Backup vault id (the `{backupvault}` segment of
   * `projects/{project}/locations/{location}/backupVaults/{backupvault}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. 3-63 characters. Immutable — changing it replaces the
   * vault.
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
   * Default and minimum enforced retention for each backup. Duration
   * string (`86400s`, `259200s`, …). Longer values raise storage cost.
   * @default "86400s"
   */
  backupMinimumEnforcedRetentionDuration?: string;
  /**
   * How a backup's enforced retention end time is inherited.
   */
  backupRetentionInheritance?:
    | backupdr.BackupVaultBackupRetentionInheritanceEnum
    | (string & {});
  /**
   * Access restriction for restores. Default is `WITHIN_ORGANIZATION`
   * when omitted at create.
   */
  accessRestriction?: backupdr.BackupVaultAccessRestrictionEnum | (string & {});
  /**
   * Customer-managed encryption. Immutable after create.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Time after which the vault is locked (RFC3339).
   */
  effectiveTime?: string;
  /**
   * Human-readable description (2048 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User annotations (AIP-128).
   */
  annotations?: Record<string, string>;
};

export type BackupVault = Resource<
  "GCP.BackupDR.BackupVault",
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
    /** Minimum enforced retention duration. */
    backupMinimumEnforcedRetentionDuration: string | undefined;
    /** Retention inheritance setting. */
    backupRetentionInheritance: string | undefined;
    /** Access restriction. */
    accessRestriction: string | undefined;
    /** Encryption config. */
    encryptionConfig: EncryptionConfig | undefined;
    /** Lock time. */
    effectiveTime: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Service account used by the vault. */
    serviceAccount: string | undefined;
    /** Number of backups in the vault. */
    backupCount: string | undefined;
    /** Total stored bytes. */
    totalStoredBytes: string | undefined;
    /** Whether the vault has no nested backups. */
    deletable: boolean | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup and DR backup vault — the storage location for backups created
 * by Backup Plans.
 *
 * Changing `backupVaultId`, `location`, or `encryptionConfig` replaces
 * the vault. Description, labels, annotations, retention, access
 * restriction, and inheritance update in place.
 *
 * ### Creating a Backup Vault
 * **Example:** Generated name
 * ```typescript
 * const vault = yield* GCP.BackupDR.BackupVault("Vault", {});
 * ```
 *
 * **Example:** Explicit id, retention, and labels
 * ```typescript
 * const vault = yield* GCP.BackupDR.BackupVault("Vault", {
 *   backupVaultId: "app-backups",
 *   backupMinimumEnforcedRetentionDuration: "86400s",
 *   description: "nightly backups",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup Vault
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const vault = yield* GCP.BackupDR.BackupVault("Vault", {
 *   description: "nightly backups v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category BackupDR
 */
export const BackupVault = Resource<BackupVault>("GCP.BackupDR.BackupVault");

const resourceName = (
  project: string,
  location: string,
  backupVaultId: string,
) => `projects/${project}/locations/${location}/backupVaults/${backupVaultId}`;

const toEncryption = (
  config: backupdr.EncryptionConfig | EncryptionConfig | undefined,
): EncryptionConfig | undefined =>
  config === undefined ? undefined : { kmsKeyName: config.kmsKeyName };

const toAttrs = (
  item: backupdr.BackupVault,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backupVaults", region);
  return {
    name,
    backupVaultId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    backupMinimumEnforcedRetentionDuration:
      item.backupMinimumEnforcedRetentionDuration,
    backupRetentionInheritance: item.backupRetentionInheritance,
    accessRestriction: item.accessRestriction,
    encryptionConfig: toEncryption(item.encryptionConfig),
    effectiveTime: item.effectiveTime,
    description: item.description,
    labels: userLabels(item.labels),
    annotations: tagRecord(item.annotations),
    serviceAccount: item.serviceAccount,
    backupCount: item.backupCount,
    totalStoredBytes: item.totalStoredBytes,
    deletable: item.deletable,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  backupdr
    .getProjectsLocationsBackupVaults({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      backupdr.listProjectsLocationsBackupVaults.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backupVaults,
      (item) => item.labels,
    ),
  );

export const BackupVaultProvider = () =>
  Provider.succeed(BackupVault, {
    stables: [
      "name",
      "backupVaultId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKey =
        olds?.encryptionConfig?.kmsKeyName ??
        output?.encryptionConfig?.kmsKeyName;
      const nextKey = news.encryptionConfig?.kmsKeyName;
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
          previousKey !== undefined &&
          nextKey !== undefined &&
          previousKey !== nextKey,
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
        const items = yield* listOwned(env.project, env.region);
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
      const retention =
        news.backupMinimumEnforcedRetentionDuration ?? DEFAULT_RETENTION;
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* backupdr
          .createProjectsLocationsBackupVaults({
            parent: parentOf(env.project, location),
            backupVaultId,
            body: {
              backupMinimumEnforcedRetentionDuration: retention,
              backupRetentionInheritance: news.backupRetentionInheritance,
              accessRestriction: news.accessRestriction,
              encryptionConfig: news.encryptionConfig,
              effectiveTime: news.effectiveTime,
              description: news.description,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
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
      const observedAnnotations = tagRecord(current.annotations);
      const desiredAnnotations = annotations ?? {};
      const annotationDiff = diffLabels(
        observedAnnotations,
        desiredAnnotations,
      );
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (annotationDiff.upsert.length > 0 ||
          annotationDiff.removed.length > 0) &&
          news.annotations !== undefined &&
          "annotations",
        !sameText(current.description, news.description) && "description",
        !sameText(current.backupMinimumEnforcedRetentionDuration, retention) &&
          "backupMinimumEnforcedRetentionDuration",
        news.backupRetentionInheritance !== undefined &&
          current.backupRetentionInheritance !==
            news.backupRetentionInheritance &&
          "backupRetentionInheritance",
        news.accessRestriction !== undefined &&
          current.accessRestriction !== news.accessRestriction &&
          "accessRestriction",
        news.effectiveTime !== undefined &&
          !sameText(current.effectiveTime, news.effectiveTime) &&
          "effectiveTime",
      ]);

      if (mask.length > 0) {
        const operation = yield* backupdr.patchProjectsLocationsBackupVaults({
          name: current.name ?? name,
          updateMask: mask,
          force: true,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            labels: desiredLabels,
            annotations: annotations ?? current.annotations,
            description: news.description,
            backupMinimumEnforcedRetentionDuration: retention,
            backupRetentionInheritance: news.backupRetentionInheritance,
            accessRestriction: news.accessRestriction,
            effectiveTime: news.effectiveTime,
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
      const operation = yield* backupdr
        .deleteProjectsLocationsBackupVaults({
          name: output.name,
          force: true,
          ignoreBackupPlanReferences: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
