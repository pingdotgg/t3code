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
  DlpNotResolved,
  encodeDescription,
  fingerprint,
  hasOwnershipMarker,
  lastSegment,
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

export type InspectConfig = dlp.GooglePrivacyDlpV2InspectConfig;

export type OrganizationsInspectTemplateProps = {
  /**
   * Template id (the `{inspectTemplate}` segment of
   * `organizations/{organization}/inspectTemplates/{inspectTemplate}`).
   * If omitted, a unique id is generated from the stack, stage, and
   * logical id. Letters, digits, hyphens, and underscores; max 100
   * characters. Immutable — changing it replaces the template.
   */
  templateId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the template.
   */
  organization?: string;
  /**
   * Human-readable display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Inspect templates
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Inspection configuration applied when this template is used.
   */
  inspectConfig: InspectConfig;
  /**
   * Allow limited-availability built-in infoTypes in `inspectConfig`.
   * @default false
   */
  allowLimitedAvailabilityInfoTypes?: boolean;
};

export type OrganizationsInspectTemplate = Resource<
  "GCP.DLP.OrganizationsInspectTemplate",
  OrganizationsInspectTemplateProps,
  {
    /** Full resource name `organizations/{organization}/inspectTemplates/{inspectTemplate}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Inspection configuration. */
    inspectConfig: InspectConfig | undefined;
    /** Whether limited-availability infoTypes are allowed. */
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
 * An organization-scoped Sensitive Data Protection inspect template.
 *
 * Templates have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Template id and organization
 * are identity. Display name, description, and inspect config update in
 * place.
 *
 * ### Creating an Inspect Template
 * **Example:** Detect email addresses
 * ```typescript
 * const template = yield* GCP.DLP.OrganizationsInspectTemplate("Emails", {
 *   displayName: "emails",
 *   inspectConfig: {
 *     infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *     includeQuote: true,
 *   },
 * });
 * ```
 *
 * **Example:** Named template on an explicit organization
 * ```typescript
 * const template = yield* GCP.DLP.OrganizationsInspectTemplate("Emails", {
 *   organization: "organizations/123456789",
 *   templateId: "emails",
 *   inspectConfig: {
 *     infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsInspectTemplate =
  Resource<OrganizationsInspectTemplate>(
    "GCP.DLP.OrganizationsInspectTemplate",
  );

const resourceName = (organization: string, templateId: string) =>
  `${organization}/inspectTemplates/${templateId}`;

const toAttrs = (
  template: dlp.GooglePrivacyDlpV2InspectTemplate,
  organization: string,
  project: string,
) => {
  const name = template.name ?? "";
  const parsed = parseName(name, "inspectTemplates");
  const ownership = parseOwnership(template.description);
  return {
    name,
    templateId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    project,
    displayName: template.displayName,
    description: ownership.text,
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
        .getOrganizationsInspectTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationsInspectTemplateProvider = () =>
  Provider.succeed(OrganizationsInspectTemplate, {
    stables: [
      "name",
      "templateId",
      "organization",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.templateId ?? output?.templateId, news.templateId) ??
        replaceOn(olds?.organization ?? output?.organization, news.organization)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const templateId = yield* toPhysicalId(
        id,
        olds?.templateId,
        output?.templateId,
      );
      const name = output?.name ?? resourceName(organization, templateId);
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
        return yield* dlp.listOrganizationsInspectTemplates
          .pages({ parent: organization, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.inspectTemplates ?? []),
            ),
            Stream.filter((template) =>
              hasOwnershipMarker(template.description),
            ),
            Stream.map((template) =>
              toAttrs(template, organization, env.project),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const templateId = yield* toPhysicalId(
        id,
        news.templateId,
        output?.templateId,
      );
      const name = resourceName(organization, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const displayName = news.displayName;
      const inspectConfig = news.inspectConfig;
      const allowLimitedAvailabilityInfoTypes =
        news.allowLimitedAvailabilityInfoTypes === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsInspectTemplates({
            parent: organization,
            body: {
              templateId,
              inspectTemplate: {
                displayName,
                description,
                inspectConfig,
                allowLimitedAvailabilityInfoTypes,
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
        fingerprint(current.inspectConfig) !== fingerprint(inspectConfig);
      const limitedChanged =
        (current.allowLimitedAvailabilityInfoTypes === true) !==
        allowLimitedAvailabilityInfoTypes;
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        configChanged ? "inspectConfig" : undefined,
        limitedChanged ? "allowLimitedAvailabilityInfoTypes" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsInspectTemplates({
          name: currentName,
          body: {
            updateMask,
            inspectTemplate: {
              displayName,
              description,
              inspectConfig,
              allowLimitedAvailabilityInfoTypes,
            },
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsInspectTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
