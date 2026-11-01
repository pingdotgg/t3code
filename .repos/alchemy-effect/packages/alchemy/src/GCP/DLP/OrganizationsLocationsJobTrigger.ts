import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  DlpNotResolved,
  encodeDescription,
  fingerprint,
  hasOwnershipMarker,
  lastSegment,
  locationParentsOf,
  organizationLocationParent,
  normalizeLocation,
  organizationIdOf,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  toPhysicalId,
  tryResolveOrganization,
  updateMaskOf,
} from "./internal.ts";

export type InspectJobConfig = dlp.GooglePrivacyDlpV2InspectJobConfig;
export type JobTriggerTrigger = dlp.GooglePrivacyDlpV2Trigger;
export type JobTriggerStatus =
  | dlp.GooglePrivacyDlpV2JobTriggerStatusEnum
  | (string & {});

export type OrganizationsLocationsJobTriggerProps = {
  /**
   * Trigger id (the `{jobTrigger}` segment of
   * `organizations/{organization}/locations/{location}/jobTriggers/{jobTrigger}`).
   * If omitted, a unique id is generated. Letters, digits, hyphens, and
   * underscores; max 100 characters. Immutable — changing it replaces
   * the trigger.
   */
  triggerId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the trigger.
   */
  organization?: string;
  /**
   * Processing location (`us-central1`, `global`, `us`, …). Immutable —
   * changing it replaces the trigger.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable display name (max 100 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Job triggers have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]` prefix
   * and stripped from attributes.
   */
  description?: string;
  /**
   * Trigger status. Prefer `PAUSED` unless jobs should run.
   * @default "PAUSED"
   */
  status?: JobTriggerStatus;
  /**
   * Events that start a job. At least one trigger is required.
   */
  triggers: JobTriggerTrigger[];
  /**
   * Inspect job configuration (what to scan and which detectors to run).
   */
  inspectJob: InspectJobConfig;
};

export type OrganizationsLocationsJobTrigger = Resource<
  "GCP.DLP.OrganizationsLocationsJobTrigger",
  OrganizationsLocationsJobTriggerProps,
  {
    /** Full resource name. */
    name: string;
    /** Trigger id (last path segment). */
    triggerId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Trigger status. */
    status: string;
    /** Triggers that start a job. */
    triggers: JobTriggerTrigger[];
    /** Inspect job configuration. */
    inspectJob: InspectJobConfig | undefined;
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
 * An organization-scoped Sensitive Data Protection job trigger that
 * inspects storage on a schedule.
 *
 * Job triggers have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Trigger id, organization,
 * and location are identity. Display name, description, status, triggers,
 * and inspect job update in place. Keep `status` as `PAUSED` unless jobs
 * should run.
 *
 * ### Creating a Job Trigger
 * **Example:** Daily paused Cloud Storage inspect
 * ```typescript
 * const trigger = yield* GCP.DLP.OrganizationsLocationsJobTrigger(
 *   "ScanBucket",
 *   {
 *     status: "PAUSED",
 *     triggers: [
 *       { schedule: { recurrencePeriodDuration: "86400s" } },
 *     ],
 *     inspectJob: {
 *       inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *       storageConfig: {
 *         cloudStorageOptions: {
 *           fileSet: { url: "gs://my-bucket/" },
 *         },
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsLocationsJobTrigger =
  Resource<OrganizationsLocationsJobTrigger>(
    "GCP.DLP.OrganizationsLocationsJobTrigger",
  );

const DEFAULT_STATUS = "PAUSED" satisfies JobTriggerStatus;

const resourceName = (
  organization: string,
  location: string,
  triggerId: string,
) =>
  `${organizationLocationParent(organization, location)}/jobTriggers/${triggerId}`;

const toAttrs = (
  trigger: dlp.GooglePrivacyDlpV2JobTrigger,
  organization: string,
  project: string,
) => {
  const name = trigger.name ?? "";
  const parsed = parseName(name, "jobTriggers");
  const ownership = parseOwnership(trigger.description);
  return {
    name,
    triggerId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || DEFAULT_LOCATION,
    project,
    displayName: trigger.displayName,
    description: ownership.text,
    status: trigger.status ?? DEFAULT_STATUS,
    triggers: trigger.triggers ?? [],
    inspectJob: trigger.inspectJob,
    createTime: trigger.createTime,
    updateTime: trigger.updateTime,
    lastRunTime: trigger.lastRunTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getOrganizationsLocationsJobTriggers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, organization: string, project: string) =>
  dlp.listOrganizationsLocationsJobTriggers
    .pages({ parent, pageSize: 100, type: "INSPECT_JOB" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.jobTriggers ?? [])),
      Stream.filter((trigger) => hasOwnershipMarker(trigger.description)),
      Stream.map((trigger) => toAttrs(trigger, organization, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const statusOf = (value: string | undefined) => value ?? DEFAULT_STATUS;

export const OrganizationsLocationsJobTriggerProvider = () =>
  Provider.succeed(OrganizationsLocationsJobTrigger, {
    stables: [
      "name",
      "triggerId",
      "organization",
      "organizationId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return (
        replaceOn(olds?.triggerId ?? output?.triggerId, news.triggerId) ??
        replaceOn(
          olds?.organization ?? output?.organization,
          news.organization,
        ) ??
        replaceOn(previousLocation, nextLocation)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const triggerId = yield* toPhysicalId(
        id,
        olds?.triggerId,
        output?.triggerId,
      );
      const name =
        output?.name ?? resourceName(organization, location, triggerId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const pages = yield* Effect.forEach(
          locationParentsOf(organization, env.region),
          (parent) => listAt(parent, organization, env.project),
          { concurrency: 3 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const triggerId = yield* toPhysicalId(
        id,
        news.triggerId,
        output?.triggerId,
      );
      const parent = organizationLocationParent(organization, location);
      const name = resourceName(organization, location, triggerId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const displayName = news.displayName;
      const status = statusOf(news.status);
      const triggers = news.triggers;
      const inspectJob = news.inspectJob;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsLocationsJobTriggers({
            parent,
            body: {
              triggerId,
              jobTrigger: {
                displayName,
                description,
                status,
                triggers,
                inspectJob,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DlpNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const statusChanged = !sameText(current.status, status);
      const triggersChanged =
        fingerprint(current.triggers) !== fingerprint(triggers);
      const jobChanged =
        fingerprint(current.inspectJob) !== fingerprint(inspectJob);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        statusChanged ? "status" : undefined,
        triggersChanged ? "triggers" : undefined,
        jobChanged ? "inspectJob" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsLocationsJobTriggers({
          name: currentName,
          body: {
            updateMask,
            jobTrigger: {
              displayName,
              description,
              status,
              triggers,
              inspectJob,
            },
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsLocationsJobTriggers({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
