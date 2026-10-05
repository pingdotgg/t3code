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

type InspectConfig = dlp.GooglePrivacyDlpV2InspectConfig;

export type LocationsInspectTemplateProps = {
  /**
   * Template id (the `{inspectTemplate}` segment of
   * `projects/{project}/locations/{location}/inspectTemplates/{inspectTemplate}`).
   * If omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * template.
   */
  templateId?: string;
  /**
   * Processing location (`us-central1`, `global`, …). Immutable —
   * changing it replaces the template.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Inspect templates
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Inspection configuration (info types, likelihood, quotes, limits).
   */
  inspectConfig?: InspectConfig;
  /**
   * Allow limited-availability built-in info types in `inspectConfig`.
   * @default false
   */
  allowLimitedAvailabilityInfoTypes?: boolean;
};

export type LocationsInspectTemplate = Resource<
  "GCP.DLP.LocationsInspectTemplate",
  LocationsInspectTemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/inspectTemplates/{id}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Inspection configuration. */
    inspectConfig: InspectConfig | undefined;
    /** Whether limited-availability info types are allowed. */
    allowLimitedAvailabilityInfoTypes: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Cloud DLP inspect template
 * (`projects.locations.inspectTemplates`).
 *
 * Inspect templates have no labels field, so Alchemy stamps ownership
 * into the description for `list` / nuke. Location and id are identity —
 * changing them replaces the template. Display name, description, and
 * inspect config update in place.
 *
 * ### Creating an Inspect Template
 * **Example:** Email detector
 * ```typescript
 * const template = yield* GCP.DLP.LocationsInspectTemplate("Email", {
 *   displayName: "email",
 *   description: "detect email addresses",
 *   inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 * });
 * ```
 *
 * ### Updating an Inspect Template
 * **Example:** Raise the likelihood threshold
 * ```typescript
 * const template = yield* GCP.DLP.LocationsInspectTemplate("Email", {
 *   displayName: "email",
 *   description: "detect email addresses v2",
 *   inspectConfig: {
 *     infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *     minLikelihood: "LIKELY",
 *     includeQuote: true,
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const LocationsInspectTemplate = Resource<LocationsInspectTemplate>(
  "GCP.DLP.LocationsInspectTemplate",
);

export class LocationsInspectTemplateNotResolved extends Data.TaggedError(
  "GCP.DLP.LocationsInspectTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, templateId: string) =>
  `${locationParent(project, location)}/inspectTemplates/${templateId}`;

const toAttrs = (
  template: dlp.GooglePrivacyDlpV2InspectTemplate,
  project: string,
  region: string,
) => {
  const name = template.name ?? "";
  const parsed = parseOwnership(template.description);
  return {
    name,
    templateId: lastSegment(name),
    location: locationOf(name, region),
    project,
    displayName: template.displayName,
    description: parsed.text,
    inspectConfig: template.inspectConfig,
    allowLimitedAvailabilityInfoTypes:
      template.allowLimitedAvailabilityInfoTypes === true,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsLocationsInspectTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LocationsInspectTemplateProvider = () =>
  Provider.succeed(LocationsInspectTemplate, {
    stables: ["name", "templateId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.templateId ?? output?.templateId;
      const idChanged =
        previousId !== undefined &&
        news.templateId !== undefined &&
        news.templateId !== previousId;
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
      const templateId = yield* toResourceId(
        id,
        olds?.templateId,
        output?.templateId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, templateId);
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
          dlp.listProjectsLocationsInspectTemplates.pages({
            parent: locationParent(env.project, env.region),
            pageSize: 100,
          }),
          (page) => page.inspectTemplates,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2InspectTemplate[]),
          ),
        );
        return items
          .filter((template) => hasOwnershipMarker(template.description))
          .map((template) => toAttrs(template, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const templateId = yield* toResourceId(
        id,
        news.templateId,
        output?.templateId,
      );
      const name = resourceName(env.project, location, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const allowLimitedAvailabilityInfoTypes =
        news.allowLimitedAvailabilityInfoTypes === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsInspectTemplates({
            parent: locationParent(env.project, location),
            body: {
              templateId,
              inspectTemplate: {
                displayName: news.displayName,
                description,
                inspectConfig: news.inspectConfig,
                allowLimitedAvailabilityInfoTypes,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsInspectTemplateNotResolved({ name });
      }

      const displayChanged = !jsonEqual(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const configChanged = !jsonEqual(
        current.inspectConfig,
        news.inspectConfig,
      );
      const limitedChanged =
        (current.allowLimitedAvailabilityInfoTypes === true) !==
        allowLimitedAvailabilityInfoTypes;

      if (
        displayChanged ||
        descriptionChanged ||
        configChanged ||
        limitedChanged
      ) {
        current = yield* dlp
          .patchProjectsLocationsInspectTemplates({
            name: current.name ?? name,
            body: {
              updateMask: updateMaskOf(
                displayChanged ? "displayName" : undefined,
                descriptionChanged ? "description" : undefined,
                configChanged ? "inspectConfig" : undefined,
                limitedChanged
                  ? "allowLimitedAvailabilityInfoTypes"
                  : undefined,
              ),
              inspectTemplate: {
                displayName: news.displayName,
                description,
                inspectConfig: news.inspectConfig,
                allowLimitedAvailabilityInfoTypes,
              },
            },
          })
          .pipe();
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsInspectTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
