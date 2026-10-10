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
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOnIdentity,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

type InspectJobConfig = dlp.GooglePrivacyDlpV2InspectJobConfig;
type JobTriggerTrigger = dlp.GooglePrivacyDlpV2Trigger;
type JobTriggerStatus = dlp.GooglePrivacyDlpV2JobTriggerStatusEnum;

export type JobTriggerProps = {
  /**
   * Trigger id (the `{jobTrigger}` segment of
   * `projects/{project}/jobTriggers/{jobTrigger}`). If omitted, a unique
   * name is generated. Must match `[a-zA-Z0-9_-]+` and is at most 100
   * characters. Immutable — changing it replaces the trigger.
   */
  triggerId?: string;
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
   * Inspect-job configuration run when the trigger fires.
   */
  inspectJob?: InspectJobConfig;
  /**
   * Triggers OR'ed together. At least one is required; typically a
   * schedule with `recurrencePeriodDuration` of at least one day.
   */
  triggers?: JobTriggerTrigger[];
};

export type JobTrigger = Resource<
  "GCP.DLP.JobTrigger",
  JobTriggerProps,
  {
    /** Full resource name `projects/{project}/jobTriggers/{id}`. */
    name: string;
    /** Trigger id (last path segment). */
    triggerId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Trigger status. */
    status: string | undefined;
    /** Inspect-job configuration. */
    inspectJob: InspectJobConfig | undefined;
    /** Trigger list. */
    triggers: JobTriggerTrigger[];
    /** RFC3339 last-run timestamp. */
    lastRunTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Cloud DLP job trigger.
 *
 * Job triggers have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Trigger id is identity — changing
 * it replaces the trigger. Display name, description, status, inspect
 * job, and schedule update in place.
 *
 * ### Creating a Job Trigger
 * **Example:** Paused daily hybrid inspect
 * ```typescript
 * const trigger = yield* GCP.DLP.JobTrigger("Nightly", {
 *   displayName: "nightly hybrid",
 *   status: "PAUSED",
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: { description: "hybrid" } },
 *   },
 *   triggers: [{ manual: {} }],
 * });
 * ```
 *
 * ### Updating a Job Trigger
 * **Example:** Change the display name
 * ```typescript
 * const trigger = yield* GCP.DLP.JobTrigger("Nightly", {
 *   displayName: "nightly hybrid v2",
 *   status: "PAUSED",
 *   inspectJob: {
 *     inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *     storageConfig: { hybridOptions: { description: "hybrid" } },
 *   },
 *   triggers: [{ manual: {} }],
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const JobTrigger = Resource<JobTrigger>("GCP.DLP.JobTrigger");

export class JobTriggerNotResolved extends Data.TaggedError(
  "GCP.DLP.JobTriggerNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_STATUS: JobTriggerStatus = "PAUSED";

const resourceName = (project: string, triggerId: string) =>
  `projects/${project}/jobTriggers/${triggerId}`;

const toAttrs = (
  trigger: dlp.GooglePrivacyDlpV2JobTrigger,
  project: string,
) => {
  const name = trigger.name ?? "";
  const parsed = parseOwnership(trigger.description);
  return {
    name,
    triggerId: lastSegment(name),
    project: projectOf(name) || project,
    displayName: trigger.displayName,
    description: parsed.text,
    status: trigger.status,
    inspectJob: trigger.inspectJob,
    triggers: trigger.triggers ?? [],
    lastRunTime: trigger.lastRunTime,
    createTime: trigger.createTime,
    updateTime: trigger.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsJobTriggers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const JobTriggerProvider = () =>
  Provider.succeed(JobTrigger, {
    stables: ["name", "triggerId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.triggerId ?? output?.triggerId;
      return replaceOnIdentity(
        previous !== undefined &&
          news.triggerId !== undefined &&
          news.triggerId !== previous,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const triggerId = yield* toResourceId(
        id,
        olds?.triggerId,
        output?.triggerId,
      );
      const name = output?.name ?? resourceName(env.project, triggerId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsJobTriggers.pages({
            parent: `projects/${env.project}`,
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
          .map((trigger) => toAttrs(trigger, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const triggerId = yield* toResourceId(
        id,
        news.triggerId,
        output?.triggerId,
      );
      const name = resourceName(env.project, triggerId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const status = news.status ?? DEFAULT_STATUS;
      const body: dlp.GooglePrivacyDlpV2JobTrigger = {
        displayName: news.displayName,
        description,
        status,
        inspectJob: news.inspectJob,
        triggers: news.triggers,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsJobTriggers({
            parent: `projects/${env.project}`,
            body: {
              triggerId,
              jobTrigger: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new JobTriggerNotResolved({ name });
      }

      const displayChanged = !sameText(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const statusChanged = (current.status ?? "") !== status;
      const inspectChanged = !jsonEqual(current.inspectJob, news.inspectJob);
      const triggersChanged = !jsonEqual(current.triggers, news.triggers);

      if (
        displayChanged ||
        descriptionChanged ||
        statusChanged ||
        inspectChanged ||
        triggersChanged
      ) {
        current = yield* dlp.patchProjectsJobTriggers({
          name: current.name ?? name,
          body: {
            jobTrigger: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              statusChanged ? "status" : undefined,
              inspectChanged ? "inspectJob" : undefined,
              triggersChanged ? "triggers" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsJobTriggers({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
