import * as cloudasset from "@distilled.cloud/gcp/cloudasset_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  listSavedQueries,
  MAX_SAVED_QUERY_DESCRIPTION,
  parentOf,
  projectParent,
  replaceOn,
  scopeParent,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type IamPolicyAnalysisQuery = cloudasset.IamPolicyAnalysisQuery;
export type QueryContent = cloudasset.QueryContent;

export type SavedQueryProps = {
  /**
   * Saved query id (the `{savedQuery}` segment of
   * `projects/{project}/savedQueries/{savedQuery}`). If omitted, a
   * unique RFC1035 name is generated (4-63 characters, `a-z0-9-`).
   * Immutable — changing it replaces the query.
   */
  savedQueryId?: string;
  /**
   * Parent project, folder, or organization
   * (`projects/{project}`, `folders/{folder}`,
   * `organizations/{organization}`). Defaults to the current project.
   * Immutable — changing it replaces the query.
   */
  parent?: string;
  /**
   * Human-readable description (max 255 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * At most 10 entries including ownership labels; keys and values are
   * under 64 characters.
   */
  labels?: Record<string, string>;
  /**
   * Query payload. Defaults to an IAM policy analysis of the current
   * project.
   */
  content?: QueryContent;
};

export type SavedQuery = Resource<
  "GCP.CloudAsset.SavedQuery",
  SavedQueryProps,
  {
    /** Full resource name `projects/{project}/savedQueries/{savedQuery}`. */
    name: string;
    /** Saved query id (last path segment). */
    savedQueryId: string;
    /** Parent project, folder, or organization. */
    parent: string;
    /** Project id used when the query was reconciled. */
    project: string;
    /** User description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Query payload. */
    content: QueryContent | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Account that created the query. */
    creator: string | undefined;
    /** RFC3339 last-update timestamp. */
    lastUpdateTime: string | undefined;
    /** Account that last updated the query. */
    lastUpdater: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Asset Inventory saved query, typically an IAM policy analysis
 * that can be rerun later.
 *
 * Saved query id and parent are identity. Description, labels, and
 * content update in place. Alchemy ownership is stored in labels so
 * `list` / nuke can find the query.
 *
 * ### Creating a Saved Query
 * **Example:** Analyze IAM in the current project
 * ```typescript
 * const query = yield* GCP.CloudAsset.SavedQuery("IamAudit", {
 *   description: "who can act as service accounts",
 *   content: {
 *     iamPolicyAnalysisQuery: {
 *       scope: `projects/${project}`,
 *       accessSelector: {
 *         permissions: ["iam.serviceAccounts.actAs"],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Generated id with labels
 * ```typescript
 * const query = yield* GCP.CloudAsset.SavedQuery("IamAudit", {
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * ### Updating a Saved Query
 * **Example:** Change the description and selector
 * ```typescript
 * // Same logical id, changed props: the query is patched in place.
 * const query = yield* GCP.CloudAsset.SavedQuery("IamAudit", {
 *   description: "roles and permissions",
 *   labels: { env: "prod" },
 *   content: {
 *     iamPolicyAnalysisQuery: {
 *       scope: `projects/${project}`,
 *       accessSelector: {
 *         roles: ["roles/owner"],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category CloudAsset
 */
export const SavedQuery = Resource<SavedQuery>("GCP.CloudAsset.SavedQuery");

export class SavedQueryNotResolved extends Data.TaggedError(
  "GCP.CloudAsset.SavedQueryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, savedQueryId: string) =>
  `${parent}/savedQueries/${savedQueryId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const desiredContent = (
  project: string,
  content: QueryContent | undefined,
): QueryContent => ({
  iamPolicyAnalysisQuery: {
    ...content?.iamPolicyAnalysisQuery,
    scope: content?.iamPolicyAnalysisQuery?.scope ?? projectParent(project),
  },
});

const toAttrs = (query: cloudasset.SavedQuery, project: string) => {
  const name = query.name ?? "";
  return {
    name,
    savedQueryId: lastSegment(name),
    parent: parentOf(name, "savedQueries"),
    project,
    description: query.description,
    labels: userLabels(query.labels),
    content: query.content,
    createTime: query.createTime,
    creator: query.creator,
    lastUpdateTime: query.lastUpdateTime,
    lastUpdater: query.lastUpdater,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudasset
        .getSavedQueries({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const observe = (project: string, savedQueryId: string, outputName?: string) =>
  Effect.gen(function* () {
    const parent = yield* scopeParent(project);
    const candidates = [outputName, resourceName(parent, savedQueryId)].filter(
      (name): name is string => name !== undefined && name.length > 0,
    );
    for (const name of candidates) {
      const found = yield* getByName(name);
      if (found !== undefined) return found;
    }
    const queries = yield* listSavedQueries(parent);
    return queries.find(
      (query) => lastSegment(query.name ?? "") === savedQueryId,
    );
  });

export const SavedQueryProvider = () =>
  Provider.succeed(SavedQuery, {
    stables: ["name", "savedQueryId", "parent", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(
          olds?.savedQueryId ?? output?.savedQueryId,
          news.savedQueryId,
        ) ?? replaceOn(olds?.parent, news.parent)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const savedQueryId = yield* toPhysicalId(
        id,
        olds?.savedQueryId,
        output?.savedQueryId,
      );
      const existing = yield* observe(env.project, savedQueryId, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = yield* scopeParent(env.project);
        const queries = yield* listSavedQueries(parent);
        return queries
          .filter((query) =>
            Object.keys(query.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            ),
          )
          .map((query) => toAttrs(query, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const savedQueryId = yield* toPhysicalId(
        id,
        news.savedQueryId,
        output?.savedQueryId,
      );
      const parent = yield* scopeParent(env.project, news.parent);
      const name = resourceName(parent, savedQueryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const description = news.description?.slice(
        0,
        MAX_SAVED_QUERY_DESCRIPTION,
      );
      const content = desiredContent(env.project, news.content);
      const body: cloudasset.SavedQuery = {
        description,
        labels: desiredLabels,
        content,
      };

      let current = yield* observe(env.project, savedQueryId, output?.name);

      if (current === undefined) {
        const created = yield* cloudasset
          .createSavedQueries({
            parent,
            savedQueryId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              observe(env.project, savedQueryId, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SavedQueryNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = !sameText(current.description, description);
      const contentChanged = !sameJson(current.content, content);
      const updateMask = updateMaskOf(
        descriptionChanged ? "description" : undefined,
        labelsChanged ? "labels" : undefined,
        contentChanged ? "content" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* cloudasset.patchSavedQueries({
          name: currentName,
          updateMask,
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* cloudasset
        .deleteSavedQueries({ name: output.name })
        .pipe(Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void));
    }),
  });
