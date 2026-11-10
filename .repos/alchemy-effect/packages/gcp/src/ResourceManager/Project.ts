import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as resourcemanagerV1 from "@distilled.cloud/gcp/unstable/cloudresourcemanager_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  PROJECT_DISPLAY_MAX,
  PROJECT_DISPLAY_MIN,
  PROJECT_ID_MAX,
  PROJECT_ID_MIN,
  collectPages,
  isDeleteRequested,
  lastSegment,
  projectIdFromOperation,
  normalizeHierarchyParent,
  resourceNameFromOperation,
  sameHierarchyParent,
  tryResolveParent,
  waitForOperation,
  waitForCreate,
} from "./internal.ts";

export type ProjectProps = {
  /**
   * Globally unique project id. 6-30 lowercase letters, digits, or
   * hyphens; must start with a letter and must not end with a hyphen.
   * If omitted, a unique id is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the project.
   */
  projectId?: string;
  /**
   * Parent `organizations/{org}` or `folders/{folder}`. Defaults to the
   * current project's parent; when the current project has none, the
   * project is created standalone. Changing parent moves the project.
   */
  parent?: string;
  /**
   * User-assigned display name (4-30 characters). Defaults to the
   * project id when omitted.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Project = Resource<
  "GCP.ResourceManager.Project",
  ProjectProps,
  {
    /** Resource name `projects/{project_number}`. */
    name: string;
    /** User-assigned project id. */
    projectId: string;
    /** Parent `organizations/{org}` or `folders/{folder}`; `undefined` when standalone. */
    parent: string | undefined;
    /** User-assigned display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Lifecycle state (`ACTIVE` or `DELETE_REQUESTED`). */
    state: string | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 time a delete was requested, if any. */
    deleteTime: string | undefined;
    /** Configured capabilities when this is a management project. */
    configuredCapabilities: string[];
  },
  never,
  Providers
>;

/**
 * A Google Cloud project — the container for APIs, IAM, billing, and
 * other resources.
 *
 * `projectId` is globally unique and immutable; changing it replaces
 * the project. `parent` is moved in place. `displayName` and `labels`
 * update in place. Delete is a 30-day soft-delete (`DELETE_REQUESTED`).
 * Alchemy ownership labels are applied so `list` / `pnpm nuke:gcp` can
 * find leftover projects.
 *
 * ### Creating a Project
 * **Example:** Generated project id under the current project's parent
 * ```typescript
 * const project = yield* GCP.ResourceManager.Project("Sandbox", {});
 * ```
 *
 * **Example:** Explicit id, parent, and labels
 * ```typescript
 * const project = yield* GCP.ResourceManager.Project("Sandbox", {
 *   projectId: "my-app-sandbox",
 *   parent: "folders/123456789",
 *   displayName: "Sandbox",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Standalone project without an organization or folder
 * ```typescript
 * // With no `parent`, the project lands under the current project's
 * // organization or folder. When the current project has none, it is
 * // created standalone and `parent` is `undefined`. Google only lets user
 * // credentials create standalone projects, not service accounts.
 * const project = yield* GCP.ResourceManager.Project("Sandbox", {
 *   displayName: "Sandbox",
 * });
 * ```
 *
 * ### Updating a Project
 * **Example:** Change display name and labels
 * ```typescript
 * const project = yield* GCP.ResourceManager.Project("Sandbox", {
 *   projectId: "my-app-sandbox",
 *   displayName: "Sandbox prod",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category ResourceManager
 */
export const Project = Resource<Project>("GCP.ResourceManager.Project");

export class ProjectNotResolved extends Data.TaggedError("GCP.ResourceManager.ProjectNotResolved")<{
  resourceName: string;
}> {}

export class ProjectStillExists extends Data.TaggedError("GCP.ResourceManager.ProjectStillExists")<{
  resourceName: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const sanitizeProjectId = (value: string) => {
  let next = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.replace(/-+$/g, "");
  if (next.length > PROJECT_ID_MAX) {
    next = next.slice(0, PROJECT_ID_MAX).replace(/-+$/g, "");
  }
  if (next.length < PROJECT_ID_MIN) {
    next = `${next}xxxxxx`.slice(0, PROJECT_ID_MIN);
  }
  return next;
};

const toProjectId = (id: string, projectId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (projectId !== undefined) return sanitizeProjectId(projectId);
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: PROJECT_ID_MAX,
      lowercase: true,
    });
    return sanitizeProjectId(generated);
  });

const sanitizeDisplayName = (value: string | undefined, fallback: string) => {
  const source = (value ?? fallback).trim();
  let next = source
    .replace(/[^a-zA-Z0-9 '"\-!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (next.length === 0) next = fallback;
  if (next.length > PROJECT_DISPLAY_MAX) next = next.slice(0, PROJECT_DISPLAY_MAX);
  if (next.length < PROJECT_DISPLAY_MIN) {
    next = `${next} proj`.slice(0, PROJECT_DISPLAY_MIN);
  }
  return next;
};

const toAttrs = (project: resourcemanager.Project) => ({
  name: project.name ?? "",
  projectId: project.projectId ?? lastSegment(project.name ?? ""),
  parent: project.parent || undefined,
  displayName: project.displayName,
  labels: userLabels(project.labels),
  state: project.state,
  etag: project.etag,
  createTime: project.createTime,
  updateTime: project.updateTime,
  deleteTime: project.deleteTime,
  configuredCapabilities: project.configuredCapabilities ?? [],
});

const getByName = (name: string) =>
  resourcemanager
    .getProjects({ name })
    .pipe(Effect.catchTag(["NotFound", "ProjectNotFound"], () => Effect.undefined));

const observe = (resourceName: string | undefined, projectId: string) =>
  Effect.gen(function* () {
    if (resourceName !== undefined && resourceName.length > 0) {
      const byName = yield* getByName(resourceName);
      if (byName !== undefined) return byName;
    }
    return yield* getByName(`projects/${projectId}`);
  });

const waitUntilExists = (resourceName: string | undefined, projectId: string) =>
  observe(resourceName, projectId).pipe(
    Effect.filterOrFail(
      (project): project is resourcemanager.Project => project !== undefined,
      () =>
        new ProjectNotResolved({
          resourceName: resourceName ?? `projects/${projectId}`,
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.ProjectNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((project) =>
      project === undefined || isDeleteRequested(project.state)
        ? Effect.void
        : Effect.fail(new ProjectStillExists({ resourceName: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.ProjectStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const ensureActive = (project: resourcemanager.Project) =>
  Effect.gen(function* () {
    if (!isDeleteRequested(project.state) || project.name === undefined) {
      return project;
    }
    const operation = yield* resourcemanager.undeleteProjects({
      name: project.name,
      body: {},
    });
    yield* waitForOperation(operation);
    return yield* waitUntilExists(project.name, project.projectId ?? lastSegment(project.name));
  });

// Unlike folders, a project may be standalone (no organization or folder).
// No parent omits `parent` on create and never moves the project. A deployed
// project keeps the parent it has, so a standalone one stays out of the
// current project's hierarchy.
const resolveProjectParent = Effect.fn(function* (
  explicit: string | undefined,
  output: { readonly parent: string | undefined } | undefined,
) {
  if (explicit) return normalizeHierarchyParent(explicit);
  if (output !== undefined) {
    return output.parent ? normalizeHierarchyParent(output.parent) : undefined;
  }
  return yield* tryResolveParent();
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["name", "projectId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.projectId ?? output?.projectId;
      const nextId = news.projectId !== undefined ? sanitizeProjectId(news.projectId) : previousId;
      const idChanged =
        previousId !== undefined && news.projectId !== undefined && nextId !== previousId;
      if (!idChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId = yield* toProjectId(id, olds?.projectId, output?.projectId);
      const existing = yield* observe(output?.name, projectId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      collectPages(
        resourcemanager.searchProjects.pages({
          query: "labels.alchemy-stack:*",
          pageSize: 300,
        }),
        (page) => page.projects,
      ).pipe(
        Effect.map((projects) =>
          projects
            .filter((project) =>
              Object.keys(project.labels ?? {}).some((key) => key.startsWith("alchemy-")),
            )
            .map(toAttrs),
        ),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const projectId = yield* toProjectId(id, news.projectId, output?.projectId);
      const parent = yield* resolveProjectParent(news.parent, output);
      const displayName = sanitizeDisplayName(news.displayName, projectId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* observe(output?.name, projectId);

      if (current === undefined) {
        const created = yield* resourcemanager
          .createProjects({
            body: {
              projectId,
              parent,
              displayName,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) {
          const settled = yield* waitForCreate(created);
          current = yield* waitUntilExists(
            resourceNameFromOperation(settled, "projects/") ??
              resourceNameFromOperation(created, "projects/"),
            projectIdFromOperation(settled) ?? projectIdFromOperation(created) ?? projectId,
          );
        } else {
          current = yield* waitUntilExists(undefined, projectId);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ProjectNotResolved({
          resourceName: `projects/${projectId}`,
        });
      }

      const name = current.name;
      current = yield* ensureActive(current);

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;

      if (labelsChanged || displayChanged) {
        // v3 `projects.patch` merges labels, so it can never remove one.
        // v1 `projects.update` replaces them (v1 calls the display name `name`).
        const id = current.projectId ?? projectId;
        const observed = yield* resourcemanagerV1.getProjects({ projectId: id });
        yield* resourcemanagerV1.updateProjects({
          projectId: id,
          body: { ...observed, name: displayName, labels: desiredLabels },
        });
        current = yield* waitUntilExists(current.name ?? name, projectId);
      }

      if (
        current.parent !== undefined &&
        parent !== undefined &&
        !sameHierarchyParent(current.parent, parent)
      ) {
        const operation = yield* resourcemanager.moveProjects({
          name: current.name ?? name,
          body: { destinationParent: parent },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name, projectId);
      }

      if (current === undefined) {
        return yield* new ProjectNotResolved({
          resourceName: `projects/${projectId}`,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* resourcemanager.deleteProjects({ name: output.name }).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag(["NotFound", "ProjectNotFound"], () => Effect.undefined),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
