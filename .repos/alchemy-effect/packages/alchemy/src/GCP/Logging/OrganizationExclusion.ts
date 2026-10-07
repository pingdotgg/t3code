import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationExclusionProps = {
  /**
   * Exclusion id (the `{exclusion}` segment of
   * `organizations/{organization}/exclusions/{exclusion}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the exclusion.
   */
  exclusionId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the exclusion.
   */
  organization?: string;
  /**
   * Advanced logs filter matching entries to exclude from the `_Default`
   * sink. Required. Use `sample()` to exclude a fraction of matches.
   */
  filter: string;
  /**
   * Human-readable description. Logging exclusions have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * When true, the exclusion exists but does not exclude any entries.
   * @default false
   */
  disabled?: boolean;
};

export type OrganizationExclusion = Resource<
  "GCP.Logging.OrganizationExclusion",
  OrganizationExclusionProps,
  {
    /** Full resource name `organizations/{organization}/exclusions/{exclusionId}`. */
    name: string;
    /** Exclusion id (last path segment). */
    exclusionId: string;
    /** Organization resource name `organizations/{organization}`. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Advanced logs filter. */
    filter: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the exclusion is disabled. */
    disabled: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging exclusion on an organization's `_Default` sink.
 *
 * Exclusions drop matching log entries before they are stored in the
 * organization's `_Default` bucket (they do not apply to `_Required`).
 * An organization can have up to 10. Logging exclusions have no labels
 * field, so Alchemy stamps ownership into the description for `list` /
 * nuke. Name and organization are identity — changing either replaces
 * the exclusion.
 *
 * ### Creating an Organization Exclusion
 * **Example:** Generated name, drop debug logs
 * ```typescript
 * const exclusion = yield* GCP.Logging.OrganizationExclusion("DropDebug", {
 *   filter: "severity=DEBUG",
 *   description: "drop debug entries",
 * });
 * ```
 *
 * **Example:** Named exclusion on an explicit organization
 * ```typescript
 * const exclusion = yield* GCP.Logging.OrganizationExclusion("DropDebug", {
 *   organization: "organizations/123456789",
 *   exclusionId: "drop-debug",
 *   filter: "severity=DEBUG",
 * });
 * ```
 *
 * ### Updating an Organization Exclusion
 * **Example:** Change the filter and disable
 * ```typescript
 * const exclusion = yield* GCP.Logging.OrganizationExclusion("DropDebug", {
 *   organization: "organizations/123456789",
 *   filter: "severity<ERROR",
 *   description: "drop non-errors",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationExclusion = Resource<OrganizationExclusion>(
  "GCP.Logging.OrganizationExclusion",
);

export class OrganizationExclusionNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationExclusionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, exclusionId: string) =>
  `${organization}/exclusions/${exclusionId}`;

const exclusionIdOf = (exclusion: logging.LogExclusion) => {
  const raw = exclusion.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const toAttrs = (
  exclusion: logging.LogExclusion,
  organization: string,
  project: string,
) => {
  const exclusionId = exclusionIdOf(exclusion);
  const parsed = parseDescription(exclusion.description);
  const name = exclusion.name?.includes("/")
    ? exclusion.name
    : resourceName(organization, exclusionId);
  return {
    name,
    exclusionId,
    organization,
    organizationId: organizationIdOf(organization),
    project,
    filter: exclusion.filter ?? "",
    description: parsed.description,
    disabled: exclusion.disabled === true,
    createTime: exclusion.createTime,
    updateTime: exclusion.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getOrganizationsExclusions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationExclusionProvider = () =>
  Provider.succeed(OrganizationExclusion, {
    stables: [
      "name",
      "exclusionId",
      "organization",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.exclusionId ?? output?.exclusionId;
      const idChanged =
        previous !== undefined &&
        news.exclusionId !== undefined &&
        news.exclusionId !== previous;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const exclusionId = yield* toPhysicalId(
        id,
        olds?.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = output?.name ?? resourceName(organization, exclusionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsExclusions
          .pages({
            parent: organization,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.exclusions ?? []),
            ),
            Stream.filter((exclusion) =>
              hasOwnershipMarker(exclusion.description),
            ),
            Stream.map((exclusion) =>
              toAttrs(exclusion, organization, env.project),
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
      const exclusionId = yield* toPhysicalId(
        id,
        news.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = resourceName(organization, exclusionId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createOrganizationsExclusions({
            parent: organization,
            body: {
              name: exclusionId,
              filter: news.filter,
              description: desiredDescription,
              disabled: news.disabled === true ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationExclusionNotResolved({ name });
      }

      const desiredDisabled = news.disabled === true;
      const filterChanged = (current.filter ?? "") !== news.filter;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;
      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        disabledChanged ? "disabled" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchOrganizationsExclusions({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter,
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteOrganizationsExclusions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
