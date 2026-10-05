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

type InspectConfig = dlp.GooglePrivacyDlpV2InspectConfig;

export type InspectTemplateProps = {
  /**
   * Template id (the `{inspectTemplate}` segment of
   * `projects/{project}/inspectTemplates/{inspectTemplate}`). If omitted,
   * a unique name is generated. Must match `[a-zA-Z0-9_-]+` and is at most
   * 100 characters. Immutable — changing it replaces the template.
   */
  templateId?: string;
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
   * Inspection configuration applied when this template is referenced.
   */
  inspectConfig?: InspectConfig;
  /**
   * Allow limited-availability built-in infoTypes in `inspectConfig`.
   * @default false
   */
  allowLimitedAvailabilityInfoTypes?: boolean;
};

export type InspectTemplate = Resource<
  "GCP.DLP.InspectTemplate",
  InspectTemplateProps,
  {
    /** Full resource name `projects/{project}/inspectTemplates/{id}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Project id. */
    project: string;
    /** Display name. */
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
 * A project-scoped Cloud DLP inspect template.
 *
 * Templates have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Template id is identity — changing it
 * replaces the template. Display name, description, and inspect config
 * update in place.
 *
 * ### Creating an Inspect Template
 * **Example:** Detect email addresses
 * ```typescript
 * const template = yield* GCP.DLP.InspectTemplate("Emails", {
 *   displayName: "emails",
 *   description: "find email addresses",
 *   inspectConfig: {
 *     infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *     includeQuote: true,
 *   },
 * });
 * ```
 *
 * ### Updating an Inspect Template
 * **Example:** Also detect phone numbers
 * ```typescript
 * const template = yield* GCP.DLP.InspectTemplate("Emails", {
 *   displayName: "emails and phones",
 *   inspectConfig: {
 *     infoTypes: [{ name: "EMAIL_ADDRESS" }, { name: "PHONE_NUMBER" }],
 *     includeQuote: true,
 *   },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const InspectTemplate = Resource<InspectTemplate>(
  "GCP.DLP.InspectTemplate",
);

export class InspectTemplateNotResolved extends Data.TaggedError(
  "GCP.DLP.InspectTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, templateId: string) =>
  `projects/${project}/inspectTemplates/${templateId}`;

const toAttrs = (
  template: dlp.GooglePrivacyDlpV2InspectTemplate,
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
        .getProjectsInspectTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const InspectTemplateProvider = () =>
  Provider.succeed(InspectTemplate, {
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
          dlp.listProjectsInspectTemplates.pages({
            parent: `projects/${env.project}`,
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
      const allowLimited = news.allowLimitedAvailabilityInfoTypes === true;
      const body: dlp.GooglePrivacyDlpV2InspectTemplate = {
        displayName: news.displayName,
        description,
        inspectConfig: news.inspectConfig,
        allowLimitedAvailabilityInfoTypes: allowLimited ? true : undefined,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsInspectTemplates({
            parent: `projects/${env.project}`,
            body: {
              templateId,
              inspectTemplate: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new InspectTemplateNotResolved({ name });
      }

      const displayChanged = !sameText(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const configChanged = !jsonEqual(
        current.inspectConfig,
        news.inspectConfig,
      );
      const limitedChanged =
        (current.allowLimitedAvailabilityInfoTypes === true) !== allowLimited;

      if (
        displayChanged ||
        descriptionChanged ||
        configChanged ||
        limitedChanged
      ) {
        current = yield* dlp.patchProjectsInspectTemplates({
          name: current.name ?? name,
          body: {
            inspectTemplate: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              configChanged ? "inspectConfig" : undefined,
              limitedChanged ? "allowLimitedAvailabilityInfoTypes" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsInspectTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
