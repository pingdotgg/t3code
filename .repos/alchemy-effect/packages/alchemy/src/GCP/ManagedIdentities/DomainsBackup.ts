import * as managedidentities from "@distilled.cloud/gcp/managedidentities_v1";
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
  domainResourceOf,
  fieldMask,
  listBackups,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type DomainsBackupProps = {
  /**
   * Parent Managed Microsoft AD domain. Full name
   * `projects/{project}/locations/global/domains/{domain}` or the domain
   * FQDN. Immutable — changing it replaces the backup.
   */
  domain: string;
  /**
   * Backup id (the `{backup}` segment of
   * `.../domains/{domain}/backups/{backup}`). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * 1-63 characters, lowercase letters, numbers, and hyphens. Immutable
   * — changing it replaces the backup.
   */
  backupId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Labels are the only mutable field.
   */
  labels?: Record<string, string>;
};

export type DomainsBackup = Resource<
  "GCP.ManagedIdentities.DomainsBackup",
  DomainsBackupProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent domain resource name. */
    domain: string;
    /** Project id. */
    project: string;
    /** Resource location (`global`). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Backup type (`ON_DEMAND` or `SCHEDULED`). */
    type: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Additional status information, if available. */
    statusMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An on-demand backup of a Managed Microsoft AD domain.
 *
 * Changing `backupId` or `domain` replaces the backup. Labels update in
 * place. Create is on-demand; scheduled backups are produced by the
 * domain and are not managed here.
 *
 * ### Creating a Backup
 * **Example:** Generated name
 * ```typescript
 * const backup = yield* GCP.ManagedIdentities.DomainsBackup("Nightly", {
 *   domain: domain.name,
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const backup = yield* GCP.ManagedIdentities.DomainsBackup("Nightly", {
 *   domain: domain.name,
 *   backupId: "app-nightly",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Labels
 * ```typescript
 * const backup = yield* GCP.ManagedIdentities.DomainsBackup("Nightly", {
 *   domain: domain.name,
 *   labels: { env: "prod", team: "identity" },
 * });
 * ```
 *
 * @resource
 * @category ManagedIdentities
 */
export const DomainsBackup = Resource<DomainsBackup>(
  "GCP.ManagedIdentities.DomainsBackup",
);

const resourceName = (domain: string, backupId: string) =>
  `${domain}/backups/${backupId}`;

const toAttrs = (item: managedidentities.Backup, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backups");
  return {
    name,
    backupId: parsed.id,
    domain: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(item.labels),
    type: item.type,
    state: item.state,
    statusMessage: item.statusMessage,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : managedidentities
        .getProjectsLocationsGlobalDomainsBackups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DomainsBackupProvider = () =>
  Provider.succeed(DomainsBackup, {
    stables: [
      "name",
      "backupId",
      "domain",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDomain = domainResourceOf(
        olds?.domain ?? output?.domain ?? "",
        env.project,
      );
      const nextDomain = domainResourceOf(
        news.domain ?? olds?.domain ?? output?.domain ?? "",
        env.project,
      );
      return replaceOnIdentity({
        previousId: olds?.backupId ?? output?.backupId,
        nextId: news.backupId ?? olds?.backupId ?? output?.backupId,
        previousParent: previousDomain,
        nextParent: nextDomain,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const domain = domainResourceOf(
        olds?.domain ?? output?.domain ?? "",
        env.project,
      );
      const backupId = yield* toPhysicalId(
        id,
        olds?.backupId,
        output?.backupId,
        "backup",
      );
      const name = output?.name ?? resourceName(domain, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listBackups(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const domain = domainResourceOf(news.domain, env.project);
      const backupId = yield* toPhysicalId(
        id,
        news.backupId,
        output?.backupId,
        "backup",
      );
      const name = output?.name ?? resourceName(domain, backupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* managedidentities
          .createProjectsLocationsGlobalDomainsBackups({
            parent: domain,
            backupId,
            body: {
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
        (item: managedidentities.Backup) => item.state,
        (item: managedidentities.Backup) => item.statusMessage,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* managedidentities.patchProjectsLocationsGlobalDomainsBackups({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item: managedidentities.Backup) => item.state,
          (item: managedidentities.Backup) => item.statusMessage,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* managedidentities
        .deleteProjectsLocationsGlobalDomainsBackups({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
