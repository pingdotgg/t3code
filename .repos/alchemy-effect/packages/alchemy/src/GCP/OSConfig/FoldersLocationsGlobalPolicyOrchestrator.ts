import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_ACTION,
  DEFAULT_STATE,
  OsconfigNotResolved,
  collectOrchestrators,
  defaultOrchestratedResource,
  fieldMask,
  fingerprint,
  folderParent,
  globalParent,
  hasAlchemyLabelMap,
  orchestratedPayload,
  parseName,
  replaceOnIdentity,
  resolveFolder,
  resourceName,
  toPhysicalId,
  tryResolveFolder,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  type OrchestratedResource,
  type OrchestrationScope,
} from "./internal.ts";

export type FoldersLocationsGlobalPolicyOrchestratorProps = {
  /**
   * Folder (`folders/{folder}` or the numeric id). When omitted, the
   * stack project's parent folder is used. Immutable — changing it
   * replaces the orchestrator.
   */
  folderId?: string;
  /**
   * Orchestrator id (the `{policyOrchestrator}` segment of
   * `folders/{folder}/locations/global/policyOrchestrators/{policyOrchestrator}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the orchestrator.
   */
  policyOrchestratorId?: string;
  /**
   * Action applied to matching OS policy assignments.
   * `UPSERT` creates or updates; `DELETE` removes them.
   * @default "UPSERT"
   */
  action?: string;
  /**
   * Orchestrator state. `ACTIVE` applies changes; `STOPPED` is idle.
   * Defaults to `STOPPED` so create does not roll out assignments.
   * @default "STOPPED"
   */
  state?: string;
  /**
   * Free-form description of the orchestrator.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Resource the orchestrator creates, updates, or deletes. When omitted,
   * a no-op VALIDATION OS policy assignment is used.
   */
  orchestratedResource?: OrchestratedResource;
  /**
   * Scope of projects, folders, and zones the orchestrator targets.
   * When omitted, the parent folder is the entire scope.
   */
  orchestrationScope?: OrchestrationScope;
};

export type FoldersLocationsGlobalPolicyOrchestrator = Resource<
  "GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator",
  FoldersLocationsGlobalPolicyOrchestratorProps,
  {
    /** Full resource name. */
    name: string;
    /** Orchestrator id (last path segment). */
    policyOrchestratorId: string;
    /** Parent `folders/{folder}/locations/global`. */
    parent: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the stack (used for quota). */
    project: string;
    /** Orchestration action (`UPSERT` or `DELETE`). */
    action: string | undefined;
    /** Orchestrator state (`ACTIVE` or `STOPPED`). */
    state: string | undefined;
    /** User description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Orchestrated OS policy assignment payload. */
    orchestratedResource: OrchestratedResource | undefined;
    /** Orchestration scope selectors. */
    orchestrationScope: OrchestrationScope | undefined;
    /** Whether the orchestrator is currently applying changes. */
    reconciling: boolean | undefined;
    /** Server checksum used on update and delete. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-scoped OS Config policy orchestrator.
 *
 * Policy orchestrators upsert or delete OS policy assignments across
 * descendant projects and zones. `folderId` and `policyOrchestratorId`
 * are identity. Action, state, description, labels, the orchestrated
 * payload, and scope update in place.
 *
 * ### Creating a Policy Orchestrator
 * **Example:** Generated name on the project's parent folder
 * ```typescript
 * const orch = yield* GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator(
 *   "Debian",
 *   { labels: { env: "test" } },
 * );
 * ```
 *
 * **Example:** Explicit folder and id
 * ```typescript
 * const orch = yield* GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator(
 *   "Debian",
 *   {
 *     folderId: "123456",
 *     policyOrchestratorId: "debian-noop",
 *     state: "STOPPED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category OSConfig
 */
export const FoldersLocationsGlobalPolicyOrchestrator =
  Resource<FoldersLocationsGlobalPolicyOrchestrator>(
    "GCP.OSConfig.FoldersLocationsGlobalPolicyOrchestrator",
  );

const toAttrs = (
  item: osconfig.GoogleCloudOsconfigV2__PolicyOrchestrator,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    policyOrchestratorId: parsed.id,
    parent: parsed.parent,
    folderId: parsed.folder,
    project,
    action: item.action,
    state: item.state,
    description: item.description,
    labels: userLabels(item.labels),
    orchestratedResource: item.orchestratedResource,
    orchestrationScope: item.orchestrationScope,
    reconciling: item.reconciling,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : osconfig
        .getFoldersLocationsGlobalPolicyOrchestrators({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const desiredBody = (
  news: FoldersLocationsGlobalPolicyOrchestratorProps,
  policyOrchestratorId: string,
  desiredLabels: Record<string, string>,
): osconfig.GoogleCloudOsconfigV2__PolicyOrchestrator => ({
  action: news.action ?? DEFAULT_ACTION,
  state: news.state ?? DEFAULT_STATE,
  description: news.description,
  labels: desiredLabels,
  orchestratedResource: orchestratedPayload(
    news.orchestratedResource ??
      defaultOrchestratedResource(policyOrchestratorId.slice(0, 63)),
  ),
  orchestrationScope: news.orchestrationScope,
});

export const FoldersLocationsGlobalPolicyOrchestratorProvider = () =>
  Provider.succeed(FoldersLocationsGlobalPolicyOrchestrator, {
    stables: [
      "name",
      "policyOrchestratorId",
      "parent",
      "folderId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFolder =
        olds?.folderId !== undefined
          ? folderParent(olds.folderId)
          : output?.folderId
            ? folderParent(output.folderId)
            : "";
      const nextFolder =
        news.folderId !== undefined
          ? folderParent(news.folderId)
          : previousFolder;
      return replaceOnIdentity({
        previousId: olds?.policyOrchestratorId ?? output?.policyOrchestratorId,
        nextId:
          news.policyOrchestratorId ??
          olds?.policyOrchestratorId ??
          output?.policyOrchestratorId,
        previousParent: previousFolder,
        nextParent: nextFolder,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyOrchestratorId = yield* toPhysicalId(
        id,
        olds?.policyOrchestratorId,
        output?.policyOrchestratorId,
      );
      let name = output?.name ?? "";
      if (name.length === 0) {
        const folder =
          olds?.folderId !== undefined
            ? folderParent(olds.folderId)
            : output?.folderId
              ? folderParent(output.folderId)
              : yield* tryResolveFolder();
        if (folder === undefined) return undefined;
        name = resourceName(globalParent(folder), policyOrchestratorId);
      }
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folder = yield* tryResolveFolder();
        if (folder === undefined) return [];
        const items = yield* collectOrchestrators(
          osconfig.listFoldersLocationsGlobalPolicyOrchestrators.pages({
            parent: globalParent(folder),
            pageSize: 1000,
          }),
        );
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyOrchestratorId = yield* toPhysicalId(
        id,
        news.policyOrchestratorId,
        output?.policyOrchestratorId,
      );
      const folder = yield* resolveFolder(news.folderId, output?.folderId);
      const parent = globalParent(folder);
      const name = resourceName(parent, policyOrchestratorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, policyOrchestratorId, desiredLabels);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* osconfig
          .createFoldersLocationsGlobalPolicyOrchestrators({
            parent,
            policyOrchestratorId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new OsconfigNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const actionChanged =
        (current.action ?? DEFAULT_ACTION) !==
        (desired.action ?? DEFAULT_ACTION);
      const stateChanged =
        (current.state ?? DEFAULT_STATE) !== (desired.state ?? DEFAULT_STATE);
      const descriptionChanged =
        (current.description ?? "") !== (desired.description ?? "");
      const resourceChanged =
        fingerprint(orchestratedPayload(current.orchestratedResource)) !==
        fingerprint(desired.orchestratedResource);
      const scopeChanged =
        desired.orchestrationScope !== undefined &&
        fingerprint(current.orchestrationScope) !==
          fingerprint(desired.orchestrationScope);
      const mask = fieldMask([
        labelsChanged && "labels",
        actionChanged && "action",
        stateChanged && "state",
        descriptionChanged && "description",
        resourceChanged && "orchestratedResource",
        scopeChanged && "orchestrationScope",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* osconfig.patchFoldersLocationsGlobalPolicyOrchestrators({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              ...desired,
              name: current.name ?? name,
              etag: current.etag,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* osconfig
        .deleteFoldersLocationsGlobalPolicyOrchestrators({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
