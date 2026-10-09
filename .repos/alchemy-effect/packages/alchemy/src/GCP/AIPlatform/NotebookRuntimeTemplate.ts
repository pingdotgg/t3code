import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  jsonEqual,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  type EncryptionSpec,
  type MachineSpec,
  type NetworkSpec,
  type PersistentDiskSpec,
} from "./shared.ts";

const COLLECTION = "notebookRuntimeTemplates";
const DEFAULT_MACHINE_TYPE = "e2-standard-4";

export type NotebookEnvVar = {
  /** Environment variable name. */
  name?: string;
  /** Environment variable value. */
  value?: string;
};

export type ColabImage = {
  /** Colab Enterprise release name (e.g. `colab-enterprise-release`). */
  releaseName?: string;
};

export type PostStartupScriptConfig = {
  /** Inline post-startup script. */
  postStartupScript?: string;
  /** Cloud Storage URI of a post-startup script. */
  postStartupScriptUrl?: string;
  /** When the script runs (`RUN_ONCE`, `RUN_EVERY_START`). */
  postStartupScriptBehavior?: string;
};

export type NotebookSoftwareConfig = {
  /** Google-managed Colab image. */
  colabImage?: ColabImage;
  /** Environment variables passed to the runtime. */
  env?: NotebookEnvVar[];
  /** Post-startup script configuration. */
  postStartupScriptConfig?: PostStartupScriptConfig;
};

export type NotebookReservationAffinity = {
  /** Affinity type (`NO_RESERVATION`, `ANY_RESERVATION`, `SPECIFIC_RESERVATION`). */
  reservationAffinityType?: string;
  /** Label key of the reservation. */
  key?: string;
  /** Reservation resource names. */
  values?: string[];
};

export type NotebookRuntimeTemplateProps = {
  /**
   * Template id (the `{notebook_runtime_template}` segment). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it replaces
   * the template.
   */
  notebookRuntimeTemplateId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the template.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Defaults to the template id.
   */
  displayName?: string;
  /**
   * Human-readable description. Vertex AI cannot update it, so changing
   * it replaces the template.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Vertex AI cannot update them, so changing them replaces the template.
   */
  labels?: Record<string, string>;
  /**
   * Runtime type. Immutable.
   * `USER_DEFINED` or `ONE_CLICK`.
   */
  notebookRuntimeType?: string;
  /**
   * Machine spec. Immutable — changing it replaces the template.
   * @default { machineType: "e2-standard-4" }
   */
  machineSpec?: MachineSpec;
  /**
   * Persistent data disk attached to the runtime.
   */
  dataPersistentDiskSpec?: PersistentDiskSpec;
  /**
   * Network spec.
   */
  networkSpec?: NetworkSpec;
  /**
   * Notebook software configuration.
   */
  softwareConfig?: NotebookSoftwareConfig;
  /**
   * Customer-managed encryption key.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Compute Engine network tags.
   */
  networkTags?: string[];
  /**
   * Idle shutdown configuration.
   */
  idleShutdownConfig?: {
    idleTimeout?: string;
    idleShutdownDisabled?: boolean;
  };
  /**
   * Shielded VM config. Immutable.
   */
  shieldedVmConfig?: { enableSecureBoot?: boolean };
  /**
   * Reservation affinity.
   */
  reservationAffinity?: NotebookReservationAffinity;
};

export type NotebookRuntimeTemplate = Resource<
  "GCP.AIPlatform.NotebookRuntimeTemplate",
  NotebookRuntimeTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Template id (last path segment). */
    notebookRuntimeTemplateId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Runtime type. */
    notebookRuntimeType: string | undefined;
    /** Machine type. */
    machineType: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Etag for read-modify-write. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI notebook runtime template — machine, disk, network, and
 * software defaults used to create Colab Enterprise runtimes.
 *
 * Only `displayName` and `softwareConfig` update in place; changing
 * `notebookRuntimeTemplateId`, `location`, `machineSpec`,
 * `notebookRuntimeType`, `description`, or `labels` replaces the template.
 *
 * ### Creating a Template
 * **Example:** Generated name
 * ```typescript
 * const template = yield* GCP.AIPlatform.NotebookRuntimeTemplate("Runtime", {
 *   machineSpec: { machineType: "e2-standard-4" },
 * });
 * ```
 *
 * **Example:** Named template with labels
 * ```typescript
 * const template = yield* GCP.AIPlatform.NotebookRuntimeTemplate("Runtime", {
 *   notebookRuntimeTemplateId: "colab-default",
 *   displayName: "colab default",
 *   labels: { env: "prod" },
 *   machineSpec: { machineType: "e2-standard-4" },
 *   networkSpec: { enableInternetAccess: true },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const NotebookRuntimeTemplate = Resource<NotebookRuntimeTemplate>(
  "GCP.AIPlatform.NotebookRuntimeTemplate",
);

export class NotebookRuntimeTemplateNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.NotebookRuntimeTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, id: string) =>
  `${locationParent(project, location)}/${COLLECTION}/${id}`;

const toAttrs = (
  template: aiplatform.GoogleCloudAiplatformV1NotebookRuntimeTemplate,
  project: string,
) => {
  const name = template.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    notebookRuntimeTemplateId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: template.displayName,
    description: template.description,
    labels: userLabels(template.labels),
    notebookRuntimeType: template.notebookRuntimeType,
    machineType: template.machineSpec?.machineType,
    createTime: template.createTime,
    updateTime: template.updateTime,
    etag: template.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsNotebookRuntimeTemplates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        template,
      ): template is aiplatform.GoogleCloudAiplatformV1NotebookRuntimeTemplate =>
        template !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (template) => template === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const desiredMachine = (spec: MachineSpec | undefined): MachineSpec => ({
  machineType: spec?.machineType ?? DEFAULT_MACHINE_TYPE,
  acceleratorType: spec?.acceleratorType,
  acceleratorCount: spec?.acceleratorCount,
  gpuPartitionSize: spec?.gpuPartitionSize,
  tpuTopology: spec?.tpuTopology,
});

export const NotebookRuntimeTemplateProvider = () =>
  Provider.succeed(NotebookRuntimeTemplate, {
    stables: [
      "name",
      "notebookRuntimeTemplateId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.notebookRuntimeTemplateId ?? output?.notebookRuntimeTemplateId;
      const nextId = news.notebookRuntimeTemplateId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousMachine =
        olds?.machineSpec?.machineType ?? output?.machineType;
      const nextMachine = desiredMachine(news.machineSpec).machineType;
      const typeChanged =
        (news.notebookRuntimeType ?? olds?.notebookRuntimeType) !==
        (olds?.notebookRuntimeType ?? output?.notebookRuntimeType);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousMachine !== undefined && previousMachine !== nextMachine) ||
        (olds?.notebookRuntimeType !== undefined && typeChanged) ||
        (olds !== undefined &&
          ((news.description ?? "") !== (olds.description ?? "") ||
            JSON.stringify(news.labels ?? {}) !==
              JSON.stringify(olds.labels ?? {})));
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toPhysicalId(
        id,
        olds?.notebookRuntimeTemplateId,
        output?.notebookRuntimeTemplateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, templateId);
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
        const pages = (yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            collectPages(
              aiplatform.listProjectsLocationsNotebookRuntimeTemplates.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.notebookRuntimeTemplates ?? [])
            .filter((template) =>
              Object.keys(template.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((template) => toAttrs(template, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toPhysicalId(
        id,
        news.notebookRuntimeTemplateId,
        output?.notebookRuntimeTemplateId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, templateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? templateId;
      const machineSpec = desiredMachine(news.machineSpec);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsNotebookRuntimeTemplates({
            parent: locationParent(env.project, location),
            notebookRuntimeTemplateId: templateId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              notebookRuntimeType: news.notebookRuntimeType,
              machineSpec,
              dataPersistentDiskSpec: news.dataPersistentDiskSpec,
              networkSpec: news.networkSpec,
              softwareConfig: news.softwareConfig,
              encryptionSpec: news.encryptionSpec,
              networkTags: news.networkTags,
              idleShutdownConfig: news.idleShutdownConfig,
              shieldedVmConfig: news.shieldedVmConfig,
              reservationAffinity: news.reservationAffinity,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const createdName =
          resourceNameFromOperation(created ?? {}) ?? output?.name ?? name;
        current = yield* waitUntilExists(createdName);
      }

      if (current === undefined) {
        return yield* new NotebookRuntimeTemplateNotResolved({ name });
      }

      const observedName = current.name ?? name;
      // Only display name and software config are updatable; label and
      // description changes replace the template (see `diff`).
      const displayChanged = (current.displayName ?? "") !== displayName;
      const softwareChanged =
        news.softwareConfig !== undefined &&
        !jsonEqual(current.softwareConfig, news.softwareConfig);

      if (displayChanged || softwareChanged) {
        const updateMask = [
          displayChanged ? "display_name" : undefined,
          softwareChanged ? "software_config" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched =
          yield* aiplatform.patchProjectsLocationsNotebookRuntimeTemplates({
            name: observedName,
            updateMask: updateMask.join(","),
            body: {
              name: observedName,
              displayName,
              softwareConfig: news.softwareConfig,
              etag: current.etag,
            },
          });
        current = patched ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsNotebookRuntimeTemplates({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
