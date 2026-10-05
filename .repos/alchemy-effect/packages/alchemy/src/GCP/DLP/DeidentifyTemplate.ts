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

type DeidentifyConfig = dlp.GooglePrivacyDlpV2DeidentifyConfig;

export type DeidentifyTemplateProps = {
  /**
   * Template id (the `{deidentifyTemplate}` segment of
   * `projects/{project}/deidentifyTemplates/{deidentifyTemplate}`). If
   * omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * template.
   */
  templateId?: string;
  /**
   * Display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Deidentify templates
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * De-identify configuration applied when this template is referenced.
   */
  deidentifyConfig?: DeidentifyConfig;
};

export type DeidentifyTemplate = Resource<
  "GCP.DLP.DeidentifyTemplate",
  DeidentifyTemplateProps,
  {
    /** Full resource name `projects/{project}/deidentifyTemplates/{id}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** De-identify configuration. */
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
 * A project-scoped Cloud DLP de-identify template.
 *
 * Templates have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Template id is identity — changing it
 * replaces the template. Display name, description, and de-identify
 * config update in place.
 *
 * ### Creating a Deidentify Template
 * **Example:** Redact email addresses
 * ```typescript
 * const template = yield* GCP.DLP.DeidentifyTemplate("Emails", {
 *   displayName: "redact emails",
 *   description: "replace email findings",
 *   deidentifyConfig: {
 *     infoTypeTransformations: {
 *       transformations: [
 *         {
 *           infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *           primitiveTransformation: { replaceWithInfoTypeConfig: {} },
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Updating a Deidentify Template
 * **Example:** Also redact phone numbers
 * ```typescript
 * const template = yield* GCP.DLP.DeidentifyTemplate("Emails", {
 *   displayName: "redact emails and phones",
 *   deidentifyConfig: {
 *     infoTypeTransformations: {
 *       transformations: [
 *         {
 *           infoTypes: [
 *             { name: "EMAIL_ADDRESS" },
 *             { name: "PHONE_NUMBER" },
 *           ],
 *           primitiveTransformation: { replaceWithInfoTypeConfig: {} },
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const DeidentifyTemplate = Resource<DeidentifyTemplate>(
  "GCP.DLP.DeidentifyTemplate",
);

export class DeidentifyTemplateNotResolved extends Data.TaggedError(
  "GCP.DLP.DeidentifyTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, templateId: string) =>
  `projects/${project}/deidentifyTemplates/${templateId}`;

const toAttrs = (
  template: dlp.GooglePrivacyDlpV2DeidentifyTemplate,
  project: string,
) => {
  const name = template.name ?? "";
  const parsed = parseOwnership(template.description);
  return {
    name,
    templateId: lastSegment(name),
    project: projectOf(name) || project,
    displayName: template.displayName,
    description: parsed.text,
    deidentifyConfig: template.deidentifyConfig,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsDeidentifyTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DeidentifyTemplateProvider = () =>
  Provider.succeed(DeidentifyTemplate, {
    stables: ["name", "templateId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.templateId ?? output?.templateId;
      return replaceOnIdentity(
        previous !== undefined &&
          news.templateId !== undefined &&
          news.templateId !== previous,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toResourceId(
        id,
        olds?.templateId,
        output?.templateId,
      );
      const name = output?.name ?? resourceName(env.project, templateId);
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
          dlp.listProjectsDeidentifyTemplates.pages({
            parent: `projects/${env.project}`,
            pageSize: 100,
          }),
          (page) => page.deidentifyTemplates,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2DeidentifyTemplate[]),
          ),
        );
        return items
          .filter((template) => hasOwnershipMarker(template.description))
          .map((template) => toAttrs(template, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toResourceId(
        id,
        news.templateId,
        output?.templateId,
      );
      const name = resourceName(env.project, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const body: dlp.GooglePrivacyDlpV2DeidentifyTemplate = {
        displayName: news.displayName,
        description,
        deidentifyConfig: news.deidentifyConfig,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsDeidentifyTemplates({
            parent: `projects/${env.project}`,
            body: {
              templateId,
              deidentifyTemplate: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DeidentifyTemplateNotResolved({ name });
      }

      const displayChanged = !sameText(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const configChanged = !jsonEqual(
        current.deidentifyConfig,
        news.deidentifyConfig,
      );

      if (displayChanged || descriptionChanged || configChanged) {
        current = yield* dlp.patchProjectsDeidentifyTemplates({
          name: current.name ?? name,
          body: {
            deidentifyTemplate: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              configChanged ? "deidentifyConfig" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsDeidentifyTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
