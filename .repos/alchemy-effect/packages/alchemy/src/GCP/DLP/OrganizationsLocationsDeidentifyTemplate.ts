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

type DeidentifyConfig = dlp.GooglePrivacyDlpV2DeidentifyConfig;

export type OrganizationsLocationsDeidentifyTemplateProps = {
  /**
   * Template id (the `{deidentifyTemplate}` segment of
   * `organizations/{organization}/locations/{location}/deidentifyTemplates/{deidentifyTemplate}`).
   * If omitted, a unique id is generated. Letters, digits, hyphens, and
   * underscores; max 100 characters. Immutable — changing it replaces
   * the template.
   */
  templateId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the template.
   */
  organization?: string;
  /**
   * Processing location (`us-central1`, `global`, `us`, …). Immutable —
   * changing it replaces the template.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Deidentify templates
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * De-identification configuration applied when this template is used.
   */
  deidentifyConfig: DeidentifyConfig;
};

export type OrganizationsLocationsDeidentifyTemplate = Resource<
  "GCP.DLP.OrganizationsLocationsDeidentifyTemplate",
  OrganizationsLocationsDeidentifyTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
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
    /** De-identification configuration. */
    deidentifyConfig: DeidentifyConfig | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A location-scoped Sensitive Data Protection de-identify template on an
 * organization.
 *
 * Templates have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Template id, organization,
 * and location are identity. Display name, description, and de-identify
 * config update in place.
 *
 * ### Creating a Location Deidentify Template
 * **Example:** Redact matched infoTypes in us-central1
 * ```typescript
 * const template = yield* GCP.DLP.OrganizationsLocationsDeidentifyTemplate(
 *   "RedactPhone",
 *   {
 *     location: "us-central1",
 *     deidentifyConfig: {
 *       infoTypeTransformations: {
 *         transformations: [
 *           {
 *             primitiveTransformation: { replaceWithInfoTypeConfig: {} },
 *           },
 *         ],
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsLocationsDeidentifyTemplate =
  Resource<OrganizationsLocationsDeidentifyTemplate>(
    "GCP.DLP.OrganizationsLocationsDeidentifyTemplate",
  );

const resourceName = (
  organization: string,
  location: string,
  templateId: string,
) =>
  `${organizationLocationParent(organization, location)}/deidentifyTemplates/${templateId}`;

const toAttrs = (
  template: dlp.GooglePrivacyDlpV2DeidentifyTemplate,
  organization: string,
  project: string,
) => {
  const name = template.name ?? "";
  const parsed = parseName(name, "deidentifyTemplates");
  const ownership = parseOwnership(template.description);
  return {
    name,
    templateId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || DEFAULT_LOCATION,
    project,
    displayName: template.displayName,
    description: ownership.text,
    deidentifyConfig: template.deidentifyConfig,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getOrganizationsLocationsDeidentifyTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, organization: string, project: string) =>
  dlp.listOrganizationsLocationsDeidentifyTemplates
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.deidentifyTemplates ?? []),
      ),
      Stream.filter((template) => hasOwnershipMarker(template.description)),
      Stream.map((template) => toAttrs(template, organization, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const OrganizationsLocationsDeidentifyTemplateProvider = () =>
  Provider.succeed(OrganizationsLocationsDeidentifyTemplate, {
    stables: [
      "name",
      "templateId",
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
        replaceOn(olds?.templateId ?? output?.templateId, news.templateId) ??
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
      const templateId = yield* toPhysicalId(
        id,
        olds?.templateId,
        output?.templateId,
      );
      const name =
        output?.name ?? resourceName(organization, location, templateId);
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
      const templateId = yield* toPhysicalId(
        id,
        news.templateId,
        output?.templateId,
      );
      const parent = organizationLocationParent(organization, location);
      const name = resourceName(organization, location, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const displayName = news.displayName;
      const deidentifyConfig = news.deidentifyConfig;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsLocationsDeidentifyTemplates({
            parent,
            body: {
              templateId,
              deidentifyTemplate: {
                displayName,
                description,
                deidentifyConfig,
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
      const configChanged =
        fingerprint(current.deidentifyConfig) !== fingerprint(deidentifyConfig);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        configChanged ? "deidentifyConfig" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsLocationsDeidentifyTemplates({
          name: currentName,
          body: {
            updateMask,
            deidentifyTemplate: {
              displayName,
              description,
              deidentifyConfig,
            },
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsLocationsDeidentifyTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
