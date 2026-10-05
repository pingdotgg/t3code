import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DialogflowOperationFailed,
  DialogflowOperationPending,
  encodeOwnership,
  listAgents,
  listFlows,
  listVersions,
  ownedByAlchemy,
  ownershipLabels,
  ownershipText,
  parseOwnership,
  parseResourceName,
  resourceNameFromOperation,
  sameText,
  updateMaskOf,
  waitForOperation,
  retryQuota,
} from "./internal.ts";

export type AgentsFlowsVersionProps = {
  /**
   * Parent flow resource name
   * `projects/{project}/locations/{location}/agents/{agent}/flows/{flow}`.
   * Immutable — changing it replaces the version.
   */
  flow: string;
  /**
   * Version id (the `{version}` segment). Server-assigned on create.
   * Immutable — changing it replaces the version.
   */
  versionId?: string;
  /** Human-readable name, unique within the flow. */
  displayName?: string;
  /**
   * Description. Versions have no labels field, so Alchemy stamps
   * ownership into this field for `list` / nuke.
   */
  description?: string;
};

export type AgentsFlowsVersion = Resource<
  "GCP.Dialogflow.AgentsFlowsVersion",
  AgentsFlowsVersionProps,
  {
    /** Full resource name. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent flow resource name. */
    flow: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Version state (`RUNNING`, `SUCCEEDED`, `FAILED`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX flow version (snapshot of a flow).
 *
 * Versions have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent flow and version id are
 * immutable. Display name and description update in place. Creating a
 * version is a long-running operation.
 *
 * ### Creating a Version
 * **Example:** Snapshot
 * ```typescript
 * const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
 *   flow: flow.name,
 *   displayName: "v1",
 *   description: "initial snapshot",
 * });
 * ```
 *
 * ### Updating a Version
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
 *   flow: flow.name,
 *   displayName: "v1-ga",
 *   description: "ga snapshot",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsFlowsVersion = Resource<AgentsFlowsVersion>(
  "GCP.Dialogflow.AgentsFlowsVersion",
);

export class AgentsFlowsVersionNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsFlowsVersionNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  version: dialogflow.GoogleCloudDialogflowCxV3Version,
  project: string,
) => {
  const name = version.name ?? "";
  const parsed = parseResourceName(name, "versions");
  return {
    name,
    versionId: parsed.id,
    flow: parsed.flow || parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: version.displayName,
    description: parseOwnership(version.description).text,
    state: version.state,
    createTime: version.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsFlowsVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (version): version is dialogflow.GoogleCloudDialogflowCxV3Version =>
        version !== undefined,
      () => new DialogflowOperationPending({ operation: name }),
    ),
    Effect.filterOrFail(
      (version) => version.state !== "FAILED",
      () =>
        new DialogflowOperationFailed({
          operation: name,
          message: "flow version failed",
        }),
    ),
    Effect.filterOrFail(
      (version) => version.state === "SUCCEEDED" || version.state === undefined,
      () => new DialogflowOperationPending({ operation: name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dialogflow.OperationPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const findOwned = (id: string, flow: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const versions = yield* listVersions(flow);
    for (const version of versions) {
      if (yield* ownedByAlchemy(id, ownershipText(version))) return version;
    }
    return undefined as dialogflow.GoogleCloudDialogflowCxV3Version | undefined;
  });

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const agents = yield* listAgents(project);
    const flows = (yield* Effect.forEach(
      agents,
      (agent) => (agent.name ? listFlows(agent.name) : Effect.succeed([])),
      { concurrency: 4 },
    )).flat();
    const versions = (yield* Effect.forEach(
      flows,
      (flow) => (flow.name ? listVersions(flow.name) : Effect.succeed([])),
      { concurrency: 4 },
    )).flat();
    return versions
      .filter(
        (version) =>
          parseOwnership(version.description).labels["alchemy-id"] !==
            undefined ||
          parseOwnership(version.displayName).labels["alchemy-id"] !==
            undefined,
      )
      .map((version) => toAttrs(version, project));
  });

export const AgentsFlowsVersionProvider = () =>
  Provider.succeed(AgentsFlowsVersion, {
    stables: ["name", "versionId", "flow", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFlow = olds?.flow ?? output?.flow;
      const previousId = olds?.versionId ?? output?.versionId;
      if (
        (previousFlow !== undefined && news.flow !== previousFlow) ||
        (previousId !== undefined &&
          news.versionId !== undefined &&
          news.versionId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousFlow === news.flow &&
            previousId !== undefined &&
            news.versionId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const flow = olds?.flow ?? output?.flow;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : flow !== undefined
            ? yield* findOwned(id, flow)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const flow = news.flow;
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? "version";
      const body: dialogflow.GoogleCloudDialogflowCxV3Version = {
        displayName,
        description,
      };

      let current = yield* findOwned(id, flow, output?.name);

      if (current === undefined) {
        const operation = yield* dialogflow
          .createProjectsLocationsAgentsFlowsVersions({
            parent: flow,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          const done = yield* waitForOperation(operation);
          const name =
            resourceNameFromOperation(done) ??
            resourceNameFromOperation(operation);
          if (name !== undefined) {
            current = yield* waitUntilReady(name);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(id, flow, output?.name);
        }
      }

      if (current === undefined) {
        return yield* new AgentsFlowsVersionNotResolved({
          name:
            output?.name ?? `${flow}/versions/${news.versionId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      if (current.state === "RUNNING") {
        current = yield* waitUntilReady(currentName);
      }

      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);

      if (displayChanged || descriptionChanged) {
        current = yield* dialogflow.patchProjectsLocationsAgentsFlowsVersions({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
          ),
          body: { displayName, description, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsFlowsVersions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
