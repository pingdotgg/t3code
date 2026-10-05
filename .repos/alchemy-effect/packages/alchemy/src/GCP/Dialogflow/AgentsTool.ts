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
  DEFAULT_LOCATION,
  encodeOwnership,
  encodeOwnershipLine,
  expandAgent,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  toResourceId,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

export type ToolFunctionSpec = {
  /** JSON Schema for the tool input. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for the tool output. */
  outputSchema?: Record<string, unknown>;
};

export type ToolOpenApiSpec = {
  /** OpenAPI schema as YAML or JSON text. */
  textSchema?: string;
};

export type ToolDataStoreSpec = {
  /** Data store connections. */
  dataStoreConnections?: Array<{
    dataStore?: string;
    dataStoreType?: string;
    documentProcessingMode?: string;
  }>;
};

export type AgentsToolProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`.
   * Immutable — changing it replaces the tool.
   */
  agent: string;
  /**
   * Tool id (the `{tool}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the tool.
   */
  toolId?: string;
  /**
   * Location used when `agent` is an id rather than a resource name.
   * Immutable — changing it replaces the tool.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name. Tools have no labels field, so Alchemy stamps
   * ownership into `displayName` and `description`.
   */
  displayName?: string;
  /**
   * Human-readable description. Required by the API; Alchemy stamps
   * ownership into this field.
   */
  description?: string;
  /**
   * Client-side function spec. Used when neither `openApiSpec` nor
   * `dataStoreSpec` is set.
   */
  functionSpec?: ToolFunctionSpec;
  /** OpenAPI tool spec. Mutually exclusive with the other specs. */
  openApiSpec?: ToolOpenApiSpec;
  /** Data-store tool spec. Mutually exclusive with the other specs. */
  dataStoreSpec?: ToolDataStoreSpec;
};

export type AgentsTool = Resource<
  "GCP.Dialogflow.AgentsTool",
  AgentsToolProps,
  {
    /** Full resource name `.../agents/{agent}/tools/{tool}`. */
    name: string;
    /** Tool id (last path segment). */
    toolId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Function spec. */
    functionSpec: ToolFunctionSpec | undefined;
    /** OpenAPI spec. */
    openApiSpec: ToolOpenApiSpec | undefined;
    /** Data-store spec. */
    dataStoreSpec: ToolDataStoreSpec | undefined;
    /** Tool type (`CUSTOMIZED_TOOL`, `BUILTIN_TOOL`). */
    toolType: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX tool (function, OpenAPI, or data-store).
 *
 * Tools have no labels field — Alchemy stamps ownership into
 * `displayName` and `description` so `list` / nuke can find them. Parent
 * agent, id, and spec kind are immutable. Display name, description, and
 * spec payload update in place.
 *
 * ### Creating a Tool
 * **Example:** Function tool
 * ```typescript
 * const tool = yield* GCP.Dialogflow.AgentsTool("Lookup", {
 *   agent: agentName,
 *   displayName: "lookup",
 *   description: "Look up an order.",
 *   functionSpec: {
 *     inputSchema: {
 *       type: "object",
 *       properties: { orderId: { type: "string" } },
 *     },
 *     outputSchema: {
 *       type: "object",
 *       properties: { status: { type: "string" } },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsTool = Resource<AgentsTool>("GCP.Dialogflow.AgentsTool");

export class AgentsToolNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsToolNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_FUNCTION_SPEC: ToolFunctionSpec = {
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    properties: { result: { type: "string" } },
  },
};

const resourceName = (agent: string, toolId: string) =>
  `${agent}/tools/${toolId}`;

const specKind = (props: {
  openApiSpec?: unknown;
  dataStoreSpec?: unknown;
  functionSpec?: unknown;
}) => {
  if (props.openApiSpec) return "openapi";
  if (props.dataStoreSpec) return "datastore";
  return "function";
};

const functionSpecOf = (
  spec: dialogflow.GoogleCloudDialogflowCxV3ToolFunctionTool | undefined,
): ToolFunctionSpec | undefined => {
  if (spec === undefined) return undefined;
  return {
    inputSchema: spec.inputSchema as Record<string, unknown> | undefined,
    outputSchema: spec.outputSchema as Record<string, unknown> | undefined,
  };
};

const toAttrs = (
  tool: dialogflow.GoogleCloudDialogflowCxV3Tool,
  project: string,
  agentHint?: string,
) => {
  const name = tool.name ?? "";
  return {
    name,
    toolId: lastSegment(name),
    agent: name.includes("/tools/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(tool.displayName).text,
    description: parseOwnership(tool.description).text,
    functionSpec: functionSpecOf(tool.functionSpec),
    openApiSpec: tool.openApiSpec
      ? { textSchema: tool.openApiSpec.textSchema }
      : undefined,
    dataStoreSpec: tool.dataStoreSpec
      ? { dataStoreConnections: tool.dataStoreSpec.dataStoreConnections }
      : undefined,
    toolType: tool.toolType,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsTools({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsTools
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tools ?? [])),
      Stream.filter(
        (tool) =>
          hasOwnershipMarker(tool.displayName) ||
          hasOwnershipMarker(tool.description),
      ),
      Stream.map((tool) => toAttrs(tool, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsTools
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tools ?? [])),
      Stream.filter((tool) => tool.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const toBody = (
  news: AgentsToolProps,
  displayName: string,
  description: string,
): dialogflow.GoogleCloudDialogflowCxV3Tool => {
  const kind = specKind(news);
  return {
    displayName,
    description,
    functionSpec:
      kind === "function"
        ? (news.functionSpec ?? DEFAULT_FUNCTION_SPEC)
        : undefined,
    openApiSpec: kind === "openapi" ? news.openApiSpec : undefined,
    dataStoreSpec: kind === "datastore" ? news.dataStoreSpec : undefined,
  };
};

export const AgentsToolProvider = () =>
  Provider.succeed(AgentsTool, {
    stables: ["name", "toolId", "agent", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.toolId ?? output?.toolId;
      if (
        previousId !== undefined &&
        news.toolId !== undefined &&
        news.toolId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousKind = specKind(olds ?? output ?? {});
      const nextKind = specKind(news);
      if (previousKind !== nextKind && previousKind !== "function") {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const agent = olds?.agent
        ? expandAgent(olds.agent, env.project, location)
        : output?.agent;
      const toolId = yield* toResourceId(id, olds?.toolId, output?.toolId);
      const name =
        output?.name ??
        (agent !== undefined ? resourceName(agent, toolId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined && agent !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          agent,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, agent);
      const named = yield* ownedByAlchemy(id, existing.displayName);
      const described = yield* ownedByAlchemy(id, existing.description);
      return named || described ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) => listAt(agent.name, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const agent = expandAgent(news.agent, env.project, location);
      const toolId = yield* toResourceId(id, news.toolId, output?.toolId);
      const name = output?.name ?? resourceName(agent, toolId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const description = encodeOwnership(ownership, news.description);
      const body = toBody(news, displayName, description);

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsTools({
            parent: agent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(agent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsToolNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged = (current.description ?? "") !== description;
      const functionChanged =
        fingerprint(functionSpecOf(current.functionSpec)) !==
        fingerprint(body.functionSpec);
      const openApiChanged =
        fingerprint(current.openApiSpec) !== fingerprint(body.openApiSpec);
      const dataStoreChanged =
        fingerprint(current.dataStoreSpec) !== fingerprint(body.dataStoreSpec);

      if (
        displayChanged ||
        descriptionChanged ||
        functionChanged ||
        openApiChanged ||
        dataStoreChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsTools({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            functionChanged && body.functionSpec ? "function_spec" : undefined,
            openApiChanged && body.openApiSpec ? "open_api_spec" : undefined,
            dataStoreChanged && body.dataStoreSpec
              ? "data_store_spec"
              : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsTools({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
