import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  encodeOwnershipLine,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  toResourceId,
  retryQuota,
} from "./internal.ts";

export type AgentsToolsVersionProps = {
  /**
   * Parent tool resource name
   * `projects/{project}/locations/{location}/agents/{agent}/tools/{tool}`.
   * Immutable — changing it replaces the version.
   */
  tool: string;
  /**
   * Version id (the `{version}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Human-readable name. Tool versions have no labels field, so Alchemy
   * stamps ownership into this field. Versions are immutable snapshots —
   * changing the display name after create is a no-op.
   */
  displayName?: string;
};

export type AgentsToolsVersion = Resource<
  "GCP.Dialogflow.AgentsToolsVersion",
  AgentsToolsVersionProps,
  {
    /** Full resource name `.../tools/{tool}/versions/{version}`. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent tool resource name. */
    tool: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** RFC3339 create timestamp. */
    createTime: string | undefined;
    /** RFC3339 update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX tool version (immutable snapshot of a tool).
 *
 * Versions have no labels field and no update RPC — Alchemy stamps
 * ownership into `displayName` so `list` / nuke can find them. Reconcile
 * is observe-ensure: if the snapshot is missing it is created; later
 * display-name edits are ignored.
 *
 * ### Creating a Tool Version
 * **Example:** Snapshot
 * ```typescript
 * const version = yield* GCP.Dialogflow.AgentsToolsVersion("v1", {
 *   tool: tool.name,
 *   displayName: "initial",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsToolsVersion = Resource<AgentsToolsVersion>(
  "GCP.Dialogflow.AgentsToolsVersion",
);

export class AgentsToolsVersionNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsToolsVersionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (tool: string, versionId: string) =>
  `${tool}/versions/${versionId}`;

const toAttrs = (
  version: dialogflow.GoogleCloudDialogflowCxV3ToolVersion,
  project: string,
  toolHint?: string,
) => {
  const name = version.name ?? "";
  return {
    name,
    versionId: lastSegment(name),
    tool: name.includes("/versions/")
      ? collectionParent(name, "tools")
      : (toolHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(version.displayName).text,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsToolsVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsToolsVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.toolVersions ?? [])),
      Stream.filter((version) => hasOwnershipMarker(version.displayName)),
      Stream.map((version) => toAttrs(version, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listTools = (agent: string) =>
  dialogflow.listProjectsLocationsAgentsTools
    .pages({ parent: agent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tools ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsToolsVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.toolVersions ?? [])),
      Stream.filter((version) => version.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsToolsVersionProvider = () =>
  Provider.succeed(AgentsToolsVersion, {
    stables: ["name", "versionId", "tool", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.tool ?? output?.tool;
      if (previousParent !== undefined && news.tool !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.versionId ?? output?.versionId;
      if (
        previousId !== undefined &&
        news.versionId !== undefined &&
        news.versionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tool = olds?.tool ?? output?.tool;
      const name =
        // Version ids are assigned by the server, so only a recorded name can
        // be fetched directly (a guessed id is rejected as malformed).
        output?.name ?? "";
      let existing = yield* getByName(name);
      if (existing === undefined && tool !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          tool,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, tool);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            Effect.gen(function* () {
              const tools = yield* listTools(agent.name);
              const versions = yield* Effect.forEach(
                tools,
                (tool) =>
                  tool.name
                    ? listAt(tool.name, env.project)
                    : Effect.succeed([]),
                { concurrency: 4 },
              );
              return versions.flat();
            }),
          { concurrency: 2 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tool = news.tool;
      const versionId = yield* toResourceId(
        id,
        news.versionId,
        output?.versionId,
      );
      const name = output?.name ?? resourceName(tool, versionId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findByDisplayName(tool, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsToolsVersions({
            parent: tool,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(tool, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsToolsVersionNotResolved({ name });
      }

      return toAttrs(current, env.project, tool);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsToolsVersions({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
