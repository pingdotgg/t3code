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
  globalParent,
  hasAlchemyLabelMap,
  orchestratedPayload,
  organizationParent,
  parseName,
  replaceOnIdentity,
  resolveOrganization,
  resourceName,
  toPhysicalId,
  tryResolveOrganization,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  type OrchestratedResource,
  type OrchestrationScope,
} from "./internal.ts";

export type OrganizationsLocationsGlobalPolicyOrchestratorProps = {
  /**
   * Organization (`organizations/{organization}` or the numeric id). When
   * omitted, the stack project's organization is used. Immutable —
   * changing it replaces the orchestrator.
   */
  organizationId?: string;
  /**
   * Orchestrator id (the `{policyOrchestrator}` segment of
   * `organizations/{organization}/locations/global/policyOrchestrators/{policyOrchestrator}`).
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
   * When omitted, the parent organization is the entire scope.
   */
  orchestrationScope?: OrchestrationScope;
};

export type OrganizationsLocationsGlobalPolicyOrchestrator = Resource<
  "GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator",
  OrganizationsLocationsGlobalPolicyOrchestratorProps,
  {
    /** Full resource name. */
    name: string;
    /** Orchestrator id (last path segment). */
    policyOrchestratorId: string;
    /** Parent `organizations/{organization}/locations/global`. */
    parent: string;
    /** Organization id. */
    organizationId: string;
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
 * An organization-scoped OS Config policy orchestrator.
 *
 * Policy orchestrators upsert or delete OS policy assignments across
 * descendant projects and zones. `organizationId` and
 * `policyOrchestratorId` are identity. Action, state, description,
 * labels, the orchestrated payload, and scope update in place.
 *
 * ### Creating a Policy Orchestrator
 * **Example:** Generated name on the project's organization
 * ```typescript
 * const orch = yield* GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator(
 *   "Debian",
 *   { labels: { env: "test" } },
 * );
 * ```
 *
 * **Example:** Explicit organization and id
 * ```typescript
 * const orch = yield* GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator(
 *   "Debian",
 *   {
 *     organizationId: "123456",
 *     policyOrchestratorId: "debian-noop",
 *     state: "STOPPED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category OSConfig
 */
export const OrganizationsLocationsGlobalPolicyOrchestrator =
  Resource<OrganizationsLocationsGlobalPolicyOrchestrator>(
    "GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator",
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
    organizationId: parsed.organization,
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
        .getOrganizationsLocationsGlobalPolicyOrchestrators({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const desiredBody = (
  news: OrganizationsLocationsGlobalPolicyOrchestratorProps,
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

export const OrganizationsLocationsGlobalPolicyOrchestratorProvider = () =>
  Provider.succeed(OrganizationsLocationsGlobalPolicyOrchestrator, {
    stables: [
      "name",
      "policyOrchestratorId",
      "parent",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg =
        olds?.organizationId !== undefined
          ? organizationParent(olds.organizationId)
          : output?.organizationId
            ? organizationParent(output.organizationId)
            : "";
      const nextOrg =
        news.organizationId !== undefined
          ? organizationParent(news.organizationId)
          : previousOrg;
      return replaceOnIdentity({
        previousId: olds?.policyOrchestratorId ?? output?.policyOrchestratorId,
        nextId:
          news.policyOrchestratorId ??
          olds?.policyOrchestratorId ??
          output?.policyOrchestratorId,
        previousParent: previousOrg,
        nextParent: nextOrg,
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
        const organization =
          olds?.organizationId !== undefined
            ? organizationParent(olds.organizationId)
            : output?.organizationId
              ? organizationParent(output.organizationId)
              : yield* tryResolveOrganization();
        if (organization === undefined) return undefined;
        name = resourceName(globalParent(organization), policyOrchestratorId);
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
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const items = yield* collectOrchestrators(
          osconfig.listOrganizationsLocationsGlobalPolicyOrchestrators.pages({
            parent: globalParent(organization),
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
      const organization = yield* resolveOrganization(
        news.organizationId,
        output?.organizationId,
      );
      const parent = globalParent(organization);
      const name = resourceName(parent, policyOrchestratorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, policyOrchestratorId, desiredLabels);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* osconfig
          .createOrganizationsLocationsGlobalPolicyOrchestrators({
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
          yield* osconfig.patchOrganizationsLocationsGlobalPolicyOrchestrators({
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
        .deleteOrganizationsLocationsGlobalPolicyOrchestrators({
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
