import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 100;

export type ExclusionProps = {
  /**
   * Exclusion id (the `{exclusion}` segment of
   * `projects/{project}/exclusions/{exclusion}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Limited to
   * 100 characters: letters, digits, underscores, hyphens, periods; first
   * character must be alphanumeric. Immutable — changing it replaces the
   * exclusion.
   */
  exclusionId?: string;
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

export type Exclusion = Resource<
  "GCP.Logging.Exclusion",
  ExclusionProps,
  {
    /** Full resource name `projects/{project}/exclusions/{exclusionId}`. */
    name: string;
    /** Exclusion id (last path segment). */
    exclusionId: string;
    /** Project id. */
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
 * A Cloud Logging exclusion on the `_Default` sink.
 *
 * Exclusions drop matching log entries before they are stored in the
 * `_Default` bucket (they do not apply to `_Required`). A project can have
 * up to 10. Logging exclusions have no labels field, so Alchemy stamps
 * ownership into the description for `list` / nuke. Name is identity —
 * changing `exclusionId` replaces the exclusion.
 *
 * ### Creating an Exclusion
 * **Example:** Generated name, drop debug logs
 * ```typescript
 * const exclusion = yield* GCP.Logging.Exclusion("DropDebug", {
 *   filter: "severity=DEBUG",
 *   description: "drop debug entries",
 * });
 * ```
 *
 * **Example:** Named exclusion
 * ```typescript
 * const exclusion = yield* GCP.Logging.Exclusion("DropDebug", {
 *   exclusionId: "drop-debug",
 *   filter: "severity=DEBUG",
 *   description: "drop debug entries",
 * });
 * ```
 *
 * ### Updating an Exclusion
 * **Example:** Change the filter and disable
 * ```typescript
 * const exclusion = yield* GCP.Logging.Exclusion("DropDebug", {
 *   filter: "severity<ERROR",
 *   description: "drop non-errors",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const Exclusion = Resource<Exclusion>("GCP.Logging.Exclusion");

export class ExclusionNotResolved extends Data.TaggedError(
  "GCP.Logging.ExclusionNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const resourceName = (project: string, exclusionId: string) =>
  `projects/${project}/exclusions/${exclusionId}`;

const exclusionIdOf = (exclusion: logging.LogExclusion) => {
  const raw = exclusion.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const toId = (id: string, exclusionId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (exclusionId !== undefined) return exclusionId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `e${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toAttrs = (exclusion: logging.LogExclusion, project: string) => {
  const exclusionId = exclusionIdOf(exclusion);
  const parsed = parseDescription(exclusion.description);
  return {
    name: exclusionId.includes("/")
      ? exclusionId
      : exclusion.name?.includes("/")
        ? exclusion.name
        : resourceName(project, exclusionId),
    exclusionId,
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
    .getProjectsExclusions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ExclusionProvider = () =>
  Provider.succeed(Exclusion, {
    stables: ["name", "exclusionId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.exclusionId ?? output?.exclusionId;
      if (
        previous !== undefined &&
        news.exclusionId !== undefined &&
        news.exclusionId !== previous
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const exclusionId = yield* toId(
        id,
        olds?.exclusionId,
        output?.exclusionId,
      );
      const name = output?.name ?? resourceName(env.project, exclusionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listProjectsExclusions
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.exclusions ?? []),
            ),
            Stream.filter((exclusion) =>
              hasOwnershipMarker(exclusion.description),
            ),
            Stream.map((exclusion) => toAttrs(exclusion, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const exclusionId = yield* toId(
        id,
        news.exclusionId,
        output?.exclusionId,
      );
      const name = resourceName(env.project, exclusionId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createProjectsExclusions({
            parent: `projects/${env.project}`,
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
        return yield* new ExclusionNotResolved({ name });
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
        current = yield* logging.patchProjectsExclusions({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter,
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteProjectsExclusions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
