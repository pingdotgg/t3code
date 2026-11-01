import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { findTemplateByDescription, listTemplates } from "./internal.ts";
import {
  encodeOwnership,
  fingerprint,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  MAX_TEMPLATE_DESCRIPTION_LENGTH,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  withProjectId,
  replaceOnIdentity,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type TemplateCategory =
  | "CATEGORY_UNSPECIFIED"
  | "AI_MACHINE_LEARNING"
  | "BUSINESS_INTELLIGENCE"
  | "COLLABORATION"
  | "CUSTOMER_SERVICE"
  | "DATABASES"
  | "DEVOPS_IT"
  | "CONTENT_AND_FILES"
  | "FINANCE_AND_ACCOUNTING"
  | "HUMAN_RESOURCES"
  | "OPERATIONS"
  | "PRODUCT_PROJECT_MANAGEMENT"
  | "PRODUCTIVITY"
  | "SALES_AND_MARKETING"
  | "UNIVERSAL_CONNECTORS"
  | "UTILITY"
  | "OTHERS";

export type TemplateVisibility =
  | "VISIBILITY_UNSPECIFIED"
  | "PRIVATE"
  | "SHARED"
  | "PUBLIC";

export type TemplateComponentType =
  | "TYPE_UNSPECIFIED"
  | "TRIGGER"
  | "TASK"
  | "CONNECTOR";

export type TemplateComponent = {
  /** Component type. */
  type?: TemplateComponentType | (string & {});
  /** Component name. */
  name?: string;
};

export type TemplateBundle =
  integrations.GoogleCloudIntegrationsV1alphaTemplateBundle;

export type TemplateProps = {
  /**
   * Template id (the `{template}` segment of
   * `projects/{project}/locations/{location}/templates/{template}`).
   * Server-assigned on create when omitted. Immutable — changing it
   * replaces the template.
   */
  templateId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * template. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Template display name. Generated from the logical id when omitted.
   */
  displayName?: string;
  /**
   * Description (max 255 characters). Templates have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * How to use the template.
   */
  usageInfo?: string;
  /**
   * Link to template documentation.
   */
  docLink?: string;
  /**
   * Bundle converted into an integration when the template is used. When
   * omitted, a minimal API-trigger integration is used.
   */
  templateBundle?: TemplateBundle;
  /**
   * Components used for categorization and filtering.
   */
  components?: TemplateComponent[];
  /**
   * Business tags used to identify the template.
   * @default ["utility"]
   */
  tags?: string[];
  /**
   * Categories used when listing templates.
   * @default ["UTILITY"]
   */
  categories?: Array<TemplateCategory | (string & {})>;
  /**
   * Template author.
   */
  author?: string;
  /**
   * Visibility of the template.
   * @default "PRIVATE"
   */
  visibility?: TemplateVisibility | (string & {});
  /**
   * Resource names the template is shared with (project numbers or org
   * ids).
   */
  sharedWith?: string[];
};

export type Template = Resource<
  "GCP.Integrations.Template",
  TemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/templates/{id}`. */
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
    /** Usage notes. */
    usageInfo: string | undefined;
    /** Documentation link. */
    docLink: string | undefined;
    /** Integration bundle. */
    templateBundle: TemplateBundle | undefined;
    /** Components. */
    components: TemplateComponent[];
    /** Business tags. */
    tags: string[];
    /** Categories. */
    categories: string[];
    /** Author. */
    author: string | undefined;
    /** Visibility. */
    visibility: string | undefined;
    /** Share targets. */
    sharedWith: string[];
    /** Usage count. */
    usageCount: string | undefined;
    /** Last used time. */
    lastUsedTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

const DEFAULT_TAGS = ["utility"];
const DEFAULT_CATEGORIES: TemplateCategory[] = ["UTILITY"];
const DEFAULT_VISIBILITY: TemplateVisibility = "PRIVATE";

export const defaultTemplateBundle = (): TemplateBundle => ({
  integrationVersionTemplate: {
    key: "main",
    integrationVersion: {
      triggerConfigs: [
        {
          label: "API Trigger",
          triggerNumber: "1",
          triggerType: "API",
          triggerId: "api_trigger/alchemy",
          properties: { "Trigger name": "alchemy" },
        },
      ],
    },
  },
});

/**
 * An Application Integration template: a reusable integration bundle plus
 * metadata (categories, tags, visibility).
 *
 * Templates have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Location and id are identity — changing
 * them replaces the template. Display name, description, bundle, tags,
 * categories, and visibility update in place.
 *
 * ### Creating a Template
 * **Example:** Private utility template
 * ```typescript
 * const template = yield* GCP.Integrations.Template("Orders", {
 *   displayName: "order-sync",
 *   description: "sync orders",
 *   tags: ["orders"],
 *   categories: ["SALES_AND_MARKETING"],
 * });
 * ```
 *
 * ### Updating a Template
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename and retag
 * ```typescript
 * const template = yield* GCP.Integrations.Template("Orders", {
 *   displayName: "order-sync-v2",
 *   description: "sync orders v2",
 *   tags: ["orders", "v2"],
 *   categories: ["SALES_AND_MARKETING"],
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const Template = Resource<Template>("GCP.Integrations.Template");

export class TemplateNotResolved extends Data.TaggedError(
  "GCP.Integrations.TemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, templateId: string) =>
  `${locationParent(project, location)}/templates/${templateId}`;

const toAttrs = (
  template: integrations.GoogleCloudIntegrationsV1alphaTemplate,
  project: string,
  region: string,
) => {
  const name = withProjectId(template.name ?? "", project);
  return {
    name,
    templateId: lastSegment(name),
    location: locationOf(name, region),
    project,
    displayName: template.displayName,
    description: parseOwnership(template.description).text,
    usageInfo: template.usageInfo,
    docLink: template.docLink,
    templateBundle: template.templateBundle,
    components: [...(template.components ?? [])],
    tags: [...(template.tags ?? [])],
    categories: [...(template.categories ?? [])],
    author: template.author,
    visibility: template.visibility,
    sharedWith: [...(template.sharedWith ?? [])],
    usageCount: template.usageCount,
    lastUsedTime: template.lastUsedTime,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TemplateProvider = () =>
  Provider.succeed(Template, {
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
        news.location !== undefined &&
        normalizeLocation(news.location, env.region) !==
          normalizeLocation(previousLocation, env.region);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toResourceId(
        id,
        olds?.templateId,
        output?.templateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, templateId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findTemplateByDescription(
          locationParent(env.project, location),
          encodeOwnership(
            ownership,
            olds?.description,
            MAX_TEMPLATE_DESCRIPTION_LENGTH,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listTemplates(
          locationParent(env.project, env.region),
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
      const parent = locationParent(env.project, location);
      const templateId = yield* toResourceId(
        id,
        news.templateId,
        output?.templateId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(
        ownership,
        news.description,
        MAX_TEMPLATE_DESCRIPTION_LENGTH,
      );
      const displayName = news.displayName ?? templateId;
      const templateBundle = news.templateBundle ?? defaultTemplateBundle();
      const tags = news.tags ?? DEFAULT_TAGS;
      const categories = news.categories ?? DEFAULT_CATEGORIES;
      const visibility = news.visibility ?? DEFAULT_VISIBILITY;
      const components = news.components;
      const sharedWith = news.sharedWith;
      const body: integrations.GoogleCloudIntegrationsV1alphaTemplate = {
        displayName,
        description,
        usageInfo: news.usageInfo,
        docLink: news.docLink,
        templateBundle,
        components,
        tags,
        categories,
        author: news.author,
        visibility,
        sharedWith,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findTemplateByDescription(parent, description);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsTemplates({
            parent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findTemplateByDescription(parent, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TemplateNotResolved({ name });
      }

      const currentName = withProjectId(current.name ?? name, env.project);
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const usageChanged = !sameText(current.usageInfo, news.usageInfo);
      const docChanged = !sameText(current.docLink, news.docLink);
      const bundleChanged =
        fingerprint(current.templateBundle) !== fingerprint(templateBundle);
      const componentsChanged =
        fingerprint(current.components) !== fingerprint(components);
      const tagsChanged = fingerprint(current.tags) !== fingerprint(tags);
      const categoriesChanged =
        fingerprint(current.categories) !== fingerprint(categories);
      const authorChanged = !sameText(current.author, news.author);
      const visibilityChanged = !sameText(current.visibility, visibility);
      const sharedChanged =
        fingerprint(current.sharedWith) !== fingerprint(sharedWith);

      if (
        displayChanged ||
        descriptionChanged ||
        usageChanged ||
        docChanged ||
        bundleChanged ||
        componentsChanged ||
        tagsChanged ||
        categoriesChanged ||
        authorChanged ||
        visibilityChanged ||
        sharedChanged
      ) {
        current = yield* integrations.patchProjectsLocationsTemplates({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            descriptionChanged ? "description" : undefined,
            usageChanged ? "usageInfo" : undefined,
            docChanged ? "docLink" : undefined,
            bundleChanged ? "templateBundle" : undefined,
            componentsChanged ? "components" : undefined,
            tagsChanged ? "tags" : undefined,
            categoriesChanged ? "categories" : undefined,
            authorChanged ? "author" : undefined,
            visibilityChanged ? "visibility" : undefined,
            sharedChanged ? "sharedWith" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
