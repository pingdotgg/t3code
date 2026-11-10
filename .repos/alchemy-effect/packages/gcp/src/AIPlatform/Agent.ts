import * as aiplatform from "@distilled.cloud/gcp/unstable/aiplatform_v1beta1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasAlchemyLabelKeys,
  hasOwnershipMarker,
  normalizeLocation,
  parentOf,
  parseOwnership,
  parseResourceName,
  rfc1035,
  resourceNameFromOperation,
  stringMapOf,
  userLabels,
  waitForOperation,
} from "./internal.ts";

export type AgentTool = {
  /**
   * Tool type: `code_execution`, `filesystem`, `google_search`,
   * `mcp_server`, or `url_context`.
   */
  type?: string;
  /**
   * MCP server name. Only when `type` is `mcp_server`.
   */
  name?: string;
  /**
   * MCP server endpoint URL. Only when `type` is `mcp_server`.
   */
  url?: string;
  /**
   * MCP server headers (for example authentication). Only when `type` is
   * `mcp_server`.
   */
  headers?: Record<string, string>;
};

export type AgentProps = {
  /**
   * Agent id (the `{agent}` segment of
   * `projects/{project}/locations/{location}/agents/{agent}`). If omitted,
   * a unique name is generated. Must match
   * `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable — changing it replaces
   * the agent.
   */
  agentId?: string;
  /**
   * Location. AgentService serves agents only in `global`. Immutable —
   * changing it replaces the agent.
   * @default "global"
   */
  location?: string;
  /**
   * Base agent. Required by the API.
   * @default "antigravity-preview-05-2026"
   */
  baseAgent?: string;
  /**
   * Description. Alchemy also stamps ownership here when metadata is
   * stripped by the API.
   */
  description?: string;
  /**
   * System instruction passed to the LLM.
   */
  systemInstruction?: string;
  /**
   * Tools available to the agent.
   */
  tools?: AgentTool[];
  /**
   * User metadata. Alchemy ownership labels are merged in automatically.
   */
  metadata?: Record<string, string>;
  /**
   * Base environment (`remote`, an environment id, or a config struct).
   */
  baseEnvironment?: unknown;
};

export type Agent = Resource<
  "GCP.AIPlatform.Agent",
  AgentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/agents/{agent}`. */
    name: string;
    /** Agent id (last path segment). */
    agentId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Base agent identifier. */
    baseAgent: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** System instruction. */
    systemInstruction: string | undefined;
    /** Configured tools. */
    tools: AgentTool[];
    /** User metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Base environment. */
    baseEnvironment: unknown;
    /** Object type (`agent`). */
    object: string | undefined;
    /** RFC3339 creation timestamp. */
    created: string | undefined;
    /** RFC3339 last-update timestamp. */
    updated: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Agent — instructions and tool configuration for an LLM
 * task.
 *
 * Agent id, location, and base agent are immutable. Description, system
 * instruction, tools, and metadata update in place. Alchemy ownership is
 * stored in `metadata` (and mirrored in `description`) so `list` / nuke
 * can find the agent.
 *
 * ### Creating an Agent
 * **Example:** Generated id
 * ```typescript
 * const agent = yield* GCP.AIPlatform.Agent("Support", {
 *   systemInstruction: "Answer product questions briefly.",
 *   metadata: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id and a search tool
 * ```typescript
 * const agent = yield* GCP.AIPlatform.Agent("Research", {
 *   agentId: "research-bot",
 *   tools: [{ type: "google_search" }],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Agent = Resource<Agent>("GCP.AIPlatform.Agent");

export class AgentNotResolved extends Data.TaggedError("GCP.AIPlatform.AgentNotResolved")<{
  resourceName: string;
}> {}

export class AgentStillExists extends Data.TaggedError("GCP.AIPlatform.AgentStillExists")<{
  resourceName: string;
}> {}

const DEFAULT_BASE_AGENT = "antigravity-preview-05-2026";

// AgentService answers 400 "AgentService not supported in this location"
// for regional locations such as us-central1.
const DEFAULT_LOCATION = "global";

const resourceName = (project: string, location: string, agentId: string) =>
  `projects/${project}/locations/${location}/agents/${agentId}`;

const toId = (id: string, agentId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (agentId !== undefined) return rfc1035(agentId);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const toolsOf = (
  tools:
    | readonly AgentTool[]
    | readonly aiplatform.GoogleCloudAiplatformV1beta1AgentTool[]
    | undefined,
): AgentTool[] =>
  (tools ?? []).map((tool) => ({
    type: tool.type,
    name: tool.name,
    url: tool.url,
    headers: stringMapOf(tool.headers),
  }));

const toAttrs = (agent: aiplatform.GoogleCloudAiplatformV1beta1Agent, project: string) => {
  const name = agent.name ?? "";
  const parsed = parseResourceName(name, "agents");
  const ownership = parseOwnership(agent.description);
  return {
    name,
    agentId: agent.id ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    baseAgent: agent.base_agent,
    description: ownership.text,
    systemInstruction: agent.system_instruction,
    tools: toolsOf(agent.tools),
    metadata: userLabels(agent.metadata),
    baseEnvironment: agent.base_environment,
    object: agent.object,
    created: agent.created,
    updated: agent.updated,
  };
};

// The v1 operations endpoint does not know AgentService operations.
const getOperation = (name: string) => aiplatform.getProjectsLocationsOperations({ name });

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsAgents({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listAgents = (project: string, locations: readonly string[]) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsAgents.pages({ parent, pageSize: 100 }).pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.agents ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
  // Vertex AI has no `locations/-` wildcard; scan the known locations.
  const scan = Effect.forEach([...new Set(locations)], (location) =>
    collect(`projects/${project}/locations/${location}`),
  ).pipe(Effect.map((pages) => pages.flat()));
  return scan.pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
};

const isOwnedAgent = (agent: aiplatform.GoogleCloudAiplatformV1beta1Agent, id: string) =>
  Effect.gen(function* () {
    if (yield* hasAlchemyLabels(id, tagRecord(agent.metadata))) return true;
    const { labels } = parseOwnership(agent.description);
    return yield* hasAlchemyLabels(id, labels);
  });

const findOwned = (id: string, project: string, location: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const agents = yield* listAgents(project, [DEFAULT_LOCATION, location]);
    for (const agent of agents) {
      if (yield* isOwnedAgent(agent, id)) return agent;
    }
    return undefined as aiplatform.GoogleCloudAiplatformV1beta1Agent | undefined;
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((agent) =>
      agent ? Effect.succeed(agent) : Effect.fail(new AgentNotResolved({ resourceName: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.AgentNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((agent) =>
      agent === undefined ? Effect.void : Effect.fail(new AgentStillExists({ resourceName: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.AgentStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const AgentProvider = () =>
  Provider.succeed(Agent, {
    stables: ["name", "agentId", "project", "location", "created"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.agentId ?? output?.agentId;
      const nextId = news.agentId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const previousBase = olds?.baseAgent ?? output?.baseAgent ?? DEFAULT_BASE_AGENT;
      const nextBase = news.baseAgent ?? previousBase;
      const replace =
        (previousId !== undefined && nextId !== undefined && rfc1035(nextId) !== previousId) ||
        previousLocation !== nextLocation ||
        previousBase !== nextBase;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          rfc1035(nextId ?? previousId) === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agentId = yield* toId(id, olds?.agentId, output?.agentId);
      const location = normalizeLocation(olds?.location ?? output?.location, DEFAULT_LOCATION);
      const name = output?.name ?? resourceName(env.project, location, agentId);
      const existing = yield* findOwned(id, env.project, location, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* isOwnedAgent(existing, id)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* listAgents(env.project, [DEFAULT_LOCATION]);
        return agents
          .filter(
            (agent) => hasAlchemyLabelKeys(agent.metadata) || hasOwnershipMarker(agent.description),
          )
          .map((agent) => toAttrs(agent, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location, DEFAULT_LOCATION);
      const agentId = yield* toId(id, news.agentId, output?.agentId);
      const name = resourceName(env.project, location, agentId);
      const internal = yield* createInternalLabels(id);
      const desiredMetadata = {
        ...toLabels(news.metadata),
        ...internal,
      };
      const desiredDescription = encodeOwnership(internal, news.description);
      const baseAgent = news.baseAgent ?? DEFAULT_BASE_AGENT;
      const tools = toolsOf(news.tools);

      let current = yield* findOwned(id, env.project, location, output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsAgents({
            parent: parentOf(env.project, location),
            body: {
              id: agentId,
              base_agent: baseAgent,
              description: desiredDescription,
              system_instruction: news.systemInstruction,
              tools,
              metadata: desiredMetadata,
              base_environment: news.baseEnvironment,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) {
          const done = yield* waitForOperation(created, { get: getOperation });
          const createdName = resourceNameFromOperation(done) ?? name;
          current = yield* waitUntilExists(createdName);
        }
        if (current === undefined) {
          current = yield* findOwned(id, env.project, location, name);
        }
      }

      if (current === undefined) {
        return yield* new AgentNotResolved({ resourceName: name });
      }

      const currentName = current.name ?? name;
      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffLabels(observedMetadata, desiredMetadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = (current.description ?? "") !== desiredDescription;
      const instructionChanged =
        (current.system_instruction ?? "") !== (news.systemInstruction ?? "");
      const toolsChanged = JSON.stringify(toolsOf(current.tools)) !== JSON.stringify(tools);

      if (metadataChanged || descriptionChanged || instructionChanged || toolsChanged) {
        // Patch is a long-running operation; re-read the agent once it lands.
        const patched = yield* aiplatform.patchProjectsLocationsAgents({
          name: currentName,
          updateMask: [
            metadataChanged ? "metadata" : undefined,
            descriptionChanged ? "description" : undefined,
            instructionChanged ? "system_instruction" : undefined,
            toolsChanged ? "tools" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name: currentName,
            metadata: desiredMetadata,
            description: desiredDescription,
            system_instruction: news.systemInstruction,
            tools,
          },
        });
        yield* waitForOperation(patched, { get: getOperation });
        current = yield* waitUntilExists(currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsAgents({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true, get: getOperation });
      }
      yield* waitUntilGone(output.name);
    }),
  });
