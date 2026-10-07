import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandApp,
  forEachApp,
  normalizeLocation,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type AppsAgentProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * agent.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Agent id (the `{agent}` segment). If omitted, a unique name is
   * generated. Immutable — changing it replaces the agent.
   */
  agentId?: string;
  /**
   * Human-readable name. Required by the API; Alchemy falls back to the
   * generated agent id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Instructions for the LLM.
   */
  instruction?: string;
  /**
   * LLM model settings for this agent.
   */
  modelSettings?: ces.ModelSettings;
  /**
   * Tool resource names available to the agent.
   */
  tools?: string[];
  /**
   * Toolset selections.
   */
  toolsets?: ces.AgentAgentToolsetList;
  /**
   * Child agent resource names.
   */
  childAgents?: string[];
  /**
   * Guardrail resource names.
   */
  guardrails?: string[];
  /**
   * Agent transfer rules.
   */
  transferRules?: ces.TransferRuleList;
  /**
   * When set, the agent delegates to a Dialogflow CX agent and other
   * agent-level properties are ignored.
   */
  remoteDialogflowAgent?: ces.AgentRemoteDialogflowAgent;
};

export type AppsAgent = Resource<
  "GCP.CES.AppsAgent",
  AppsAgentProps,
  {
    /** Full resource name `.../apps/{app}/agents/{agent}`. */
    name: string;
    /** Agent id (last path segment). */
    agentId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** LLM instructions. */
    instruction: string | undefined;
    /** Model settings. */
    modelSettings: ces.ModelSettings | undefined;
    /** Tool resource names. */
    tools: string[] | undefined;
    /** Toolset selections. */
    toolsets: ces.AgentAgentToolsetList | undefined;
    /** Child agent resource names. */
    childAgents: string[] | undefined;
    /** Guardrail resource names. */
    guardrails: string[] | undefined;
    /** Transfer rules. */
    transferRules: ces.TransferRuleList | undefined;
    /** Remote Dialogflow agent, if any. */
    remoteDialogflowAgent: ces.AgentRemoteDialogflowAgent | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite agent inside an app. Agents give the LLM
 * instructions, tools, and transfer rules for a task.
 *
 * Agents have no labels field, and the description reaches the model, so
 * Alchemy writes no ownership marker: a generated agent id identifies the
 * agent, and `read` reports an explicit id it has no state for as
 * unowned. Parent app, location, and agent id are immutable.
 *
 * ### Creating an Agent
 * **Example:** Root LLM agent
 * ```typescript
 * const agent = yield* GCP.CES.AppsAgent("Greeter", {
 *   app: app.name,
 *   displayName: "greeter",
 *   instruction: "Greet the user and offer help.",
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsAgent = Resource<AppsAgent>("GCP.CES.AppsAgent");

export class AppsAgentNotResolved extends Data.TaggedError(
  "GCP.CES.AppsAgentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, agentId: string) =>
  `${app}/agents/${agentId}`;

const toAttrs = (
  agent: ces.Agent,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = agent.name ?? "";
  const parsed = parseResourceName(name, "agents", region);
  return {
    name,
    agentId: parsed.id,
    app: name.includes("/agents/") ? parsed.app : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: agent.displayName,
    description: parseOwnership(agent.description).text,
    instruction: agent.instruction,
    modelSettings: agent.modelSettings,
    tools: agent.tools,
    toolsets: agent.toolsets,
    childAgents: agent.childAgents,
    guardrails: agent.guardrails,
    transferRules: agent.transferRules,
    remoteDialogflowAgent: agent.remoteDialogflowAgent,
    createTime: agent.createTime,
    updateTime: agent.updateTime,
    etag: agent.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsAgents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsAgents.pages({ parent, pageSize: 100 }),
    (page) => page.agents,
  ).pipe(
    Effect.map((agents) =>
      agents.map((agent) => toAttrs(agent, project, region, parent)),
    ),
  );

export const AppsAgentProvider = () =>
  Provider.succeed(AppsAgent, {
    stables: ["name", "agentId", "app", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = normalizeLocation(news.location, env.region);
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation, env.region) !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.agentId ?? output?.agentId,
        nextId: news.agentId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const app = olds?.app
        ? expandApp(olds.app, env.project, location)
        : output?.app;
      const agentId = yield* toPhysicalId(id, olds?.agentId, output?.agentId);
      const name =
        output?.name ?? (app !== undefined ? resourceName(app, agentId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return output !== undefined || olds?.agentId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* forEachApp(
          env.project,
          (parent) => listAt(parent, env.project, env.region),
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const app = expandApp(news.app, env.project, location);
      const agentId = yield* toPhysicalId(id, news.agentId, output?.agentId);
      const name = output?.name ?? resourceName(app, agentId);
      const description = news.description;
      const displayName = news.displayName ?? agentId;
      const llmAgent =
        news.remoteDialogflowAgent === undefined ? {} : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsAgents({
            parent: app,
            agentId,
            body: {
              displayName,
              description,
              instruction: news.instruction,
              modelSettings: news.modelSettings,
              tools: news.tools,
              toolsets: news.toolsets,
              childAgents: news.childAgents,
              guardrails: news.guardrails,
              transferRules: news.transferRules,
              remoteDialogflowAgent: news.remoteDialogflowAgent,
              llmAgent,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsAgentNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const instructionChanged = !sameText(
        current.instruction,
        news.instruction,
      );
      const modelChanged = !sameJson(current.modelSettings, news.modelSettings);
      const toolsChanged = !sameJson(current.tools, news.tools);
      const toolsetsChanged = !sameJson(current.toolsets, news.toolsets);
      const childrenChanged = !sameJson(current.childAgents, news.childAgents);
      const guardrailsChanged = !sameJson(current.guardrails, news.guardrails);
      const rulesChanged = !sameJson(current.transferRules, news.transferRules);
      const remoteChanged = !sameJson(
        current.remoteDialogflowAgent,
        news.remoteDialogflowAgent,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        instructionChanged ||
        modelChanged ||
        toolsChanged ||
        toolsetsChanged ||
        childrenChanged ||
        guardrailsChanged ||
        rulesChanged ||
        remoteChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsAgents({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              instructionChanged ? "instruction" : undefined,
              modelChanged ? "model_settings" : undefined,
              toolsChanged ? "tools" : undefined,
              toolsetsChanged ? "toolsets" : undefined,
              childrenChanged ? "child_agents" : undefined,
              guardrailsChanged ? "guardrails" : undefined,
              rulesChanged ? "transfer_rules" : undefined,
              remoteChanged ? "remote_dialogflow_agent" : undefined,
            ),
            body: {
              displayName,
              description,
              instruction: news.instruction,
              modelSettings: news.modelSettings,
              tools: news.tools,
              toolsets: news.toolsets,
              childAgents: news.childAgents,
              guardrails: news.guardrails,
              transferRules: news.transferRules,
              remoteDialogflowAgent: news.remoteDialogflowAgent,
              llmAgent,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsAgents({
          name: output.name,
          force: true,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
