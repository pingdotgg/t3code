import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  replaceOnIdentity,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

type InspectJobConfig = dlp.GooglePrivacyDlpV2InspectJobConfig;
type JobTriggerStatus = dlp.GooglePrivacyDlpV2JobTriggerStatusEnum;
type JobTriggerTrigger = dlp.GooglePrivacyDlpV2Trigger;

const DEFAULT_STATUS: JobTriggerStatus = "PAUSED";
const DEFAULT_TRIGGERS: JobTriggerTrigger[] = [{ manual: {} }];
const DEFAULT_INSPECT_JOB: InspectJobConfig = {
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
  storageConfig: { hybridOptions: {} },
};

export type LocationsJobTriggerProps = {
  /**
   * Trigger id (the `{jobTrigger}` segment of
   * `projects/{project}/locations/{location}/jobTriggers/{jobTrigger}`).
   * If omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * trigger.
   */
  triggerId?: string;
  /**
   * Processing location (`us-central1`, `global`, …). Immutable —
   * changing it replaces the trigger.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 100 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Job triggers have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Trigger status. `PAUSED` stores the trigger without starting jobs.
   * @default "PAUSED"
   */
  status?: JobTriggerStatus | (string & {});
  /**
   * Inspect job configuration run when the trigger fires. Defaults to a
   * hybrid EMAIL_ADDRESS inspect job.
   */
  inspectJob?: InspectJobConfig;
  /**
   * Triggers OR'ed together. Defaults to a manual (hybrid) trigger.
   */
  triggers?: JobTriggerTrigger[];
};

export type LocationsJobTrigger = Resource<
  "GCP.DLP.LocationsJobTrigger",
  LocationsJobTriggerProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/jobTriggers/{id}`. */
    name: string;
    /** Trigger id (last path segment). */
    triggerId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Trigger status. */
    status: string | undefined;
    /** Inspect job configuration. */
    inspectJob: InspectJobConfig | undefined;
    /** Trigger conditions. */
    triggers: JobTriggerTrigger[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 last-run timestamp. */
    lastRunTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Cloud DLP job trigger (`projects.locations.jobTriggers`).
 *
 * Job triggers have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Location and id are identity — changing
 * them replaces the trigger. Display name, description, status, inspect
 * job, and triggers update in place.
 *
 * ### Creating a Job Trigger
 * **Example:** Paused hybrid inspect trigger
 * ```typescript
 * const trigger = yield* GCP.DLP.LocationsJobTrigger("Inbox", {
 *   displayName: "inbox scan",
 *   description: "paused hybrid inspect",
 *   status: "PAUSED",
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: {} },
 *   },
 *   triggers: [{ manual: {} }],
 * });
 * ```
 *
 * ### Updating a Job Trigger
 * **Example:** Change the description
 * ```typescript
 * const trigger = yield* GCP.DLP.LocationsJobTrigger("Inbox", {
 *   displayName: "inbox scan",
 *   description: "paused hybrid inspect v2",
 *   status: "PAUSED",
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: {} },
 *   },
 *   triggers: [{ manual: {} }],
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const LocationsJobTrigger = Resource<LocationsJobTrigger>(
  "GCP.DLP.LocationsJobTrigger",
);

export class LocationsJobTriggerNotResolved extends Data.TaggedError(
  "GCP.DLP.LocationsJobTriggerNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, triggerId: string) =>
  `${locationParent(project, location)}/jobTriggers/${triggerId}`;

const toAttrs = (
  trigger: dlp.GooglePrivacyDlpV2JobTrigger,
  project: string,
  region: string,
) => {
  const name = trigger.name ?? "";
  const parsed = parseOwnership(trigger.description);
  return {
    name,
    triggerId: lastSegment(name),
    location: locationOf(name, region),
    project,
    displayName: trigger.displayName,
    description: parsed.text,
    status: trigger.status,
    inspectJob: trigger.inspectJob,
    triggers: trigger.triggers ?? [],
    createTime: trigger.createTime,
    updateTime: trigger.updateTime,
    lastRunTime: trigger.lastRunTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsLocationsJobTriggers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LocationsJobTriggerProvider = () =>
  Provider.succeed(LocationsJobTrigger, {
    stables: ["name", "triggerId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.triggerId ?? output?.triggerId;
      const idChanged =
        previousId !== undefined &&
        news.triggerId !== undefined &&
        news.triggerId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        normalizeLocation(news.location ?? previousLocation, env.region) !==
          normalizeLocation(previousLocation, env.region);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const triggerId = yield* toResourceId(
        id,
        olds?.triggerId,
        output?.triggerId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, triggerId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsLocationsJobTriggers.pages({
            parent: locationParent(env.project, env.region),
            pageSize: 100,
          }),
          (page) => page.jobTriggers,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2JobTrigger[]),
          ),
        );
        return items
          .filter((trigger) => hasOwnershipMarker(trigger.description))
          .map((trigger) => toAttrs(trigger, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const triggerId = yield* toResourceId(
        id,
        news.triggerId,
        output?.triggerId,
      );
      const name = resourceName(env.project, location, triggerId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const status = news.status ?? DEFAULT_STATUS;
      const inspectJob = news.inspectJob ?? DEFAULT_INSPECT_JOB;
      const triggers = news.triggers ?? DEFAULT_TRIGGERS;
      const jobTrigger: dlp.GooglePrivacyDlpV2JobTrigger = {
        displayName: news.displayName,
        description,
        status,
        inspectJob,
        triggers,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsJobTriggers({
            parent: locationParent(env.project, location),
            body: {
              triggerId,
              jobTrigger,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsJobTriggerNotResolved({ name });
      }

      const displayChanged = !jsonEqual(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const statusChanged = (current.status ?? "") !== status;
      const inspectChanged = !jsonEqual(current.inspectJob, inspectJob);
      const triggersChanged = !jsonEqual(current.triggers ?? [], triggers);

      if (
        displayChanged ||
        descriptionChanged ||
        statusChanged ||
        inspectChanged ||
        triggersChanged
      ) {
        current = yield* dlp.patchProjectsLocationsJobTriggers({
          name: current.name ?? name,
          body: {
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              statusChanged ? "status" : undefined,
              inspectChanged ? "inspectJob" : undefined,
              triggersChanged ? "triggers" : undefined,
            ),
            jobTrigger,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsJobTriggers({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
