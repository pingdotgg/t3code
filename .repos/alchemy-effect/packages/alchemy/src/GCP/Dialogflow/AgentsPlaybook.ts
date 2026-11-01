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
  sameText,
  toResourceId,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

export type PlaybookType = "PLAYBOOK_TYPE_UNSPECIFIED" | "TASK" | "ROUTINE";

export type PlaybookStep = {
  /** Instruction text for this step. */
  text?: string;
  /** Nested steps. */
  steps?: PlaybookStep[];
};

export type PlaybookInstruction = {
  /** Free-form guidelines. */
  guidelines?: string;
  /** Ordered steps. */
  steps?: PlaybookStep[];
};

export type PlaybookParameterDefinition = {
  /** Parameter name. */
  name?: string;
  /** Parameter type (`STRING`, `NUMBER`, …). */
  type?: string;
  /** Human-readable description. */
  description?: string;
};

export type PlaybookLlmModelSettings = {
  /** LLM model id. */
  model?: string;
  /** Model prompt text. */
  promptText?: string;
};

export type AgentsPlaybookProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`.
   * Immutable — changing it replaces the playbook.
   */
  agent: string;
  /**
   * Playbook id (the `{playbook}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the playbook.
   */
  playbookId?: string;
  /**
   * Location used when `agent` is an id rather than a resource name.
   * Immutable — changing it replaces the playbook.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name. Playbooks have no labels field, so Alchemy
   * stamps ownership into this field and strips it from attributes.
   */
  displayName?: string;
  /**
   * High-level goal of the playbook.
   * @default "Handle the user request."
   */
  goal?: string;
  /** Instruction block (guidelines and steps). */
  instruction?: PlaybookInstruction;
  /**
   * Playbook kind.
   * @default "TASK"
   */
  playbookType?: PlaybookType | (string & {});
  /** Referenced tool resource names. */
  referencedTools?: string[];
  /** Referenced playbook resource names. */
  referencedPlaybooks?: string[];
  /** Referenced flow resource names. */
  referencedFlows?: string[];
  /** LLM model settings. */
  llmModelSettings?: PlaybookLlmModelSettings;
  /** Inline code block. */
  codeBlock?: { code?: string };
  /** Input parameter definitions. */
  inputParameterDefinitions?: PlaybookParameterDefinition[];
  /** Output parameter definitions. */
  outputParameterDefinitions?: PlaybookParameterDefinition[];
};

export type AgentsPlaybook = Resource<
  "GCP.Dialogflow.AgentsPlaybook",
  AgentsPlaybookProps,
  {
    /** Full resource name `.../agents/{agent}/playbooks/{playbook}`. */
    name: string;
    /** Playbook id (last path segment). */
    playbookId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Goal. */
    goal: string | undefined;
    /** Instruction block. */
    instruction: PlaybookInstruction | undefined;
    /** Playbook kind. */
    playbookType: string | undefined;
    /** Referenced tools. */
    referencedTools: string[];
    /** Referenced playbooks. */
    referencedPlaybooks: string[];
    /** Referenced flows. */
    referencedFlows: string[];
    /** LLM model settings. */
    llmModelSettings: PlaybookLlmModelSettings | undefined;
    /** Token count. */
    tokenCount: string | undefined;
    /** RFC3339 create timestamp. */
    createTime: string | undefined;
    /** RFC3339 update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX playbook (goal-driven LLM workflow).
 *
 * Playbooks have no labels field — Alchemy stamps ownership into
 * `displayName` so `list` / nuke can find them. Parent agent and id are
 * immutable. Display name, goal, instruction, type, references, and LLM
 * settings update in place.
 *
 * ### Creating a Playbook
 * **Example:** Task playbook
 * ```typescript
 * const playbook = yield* GCP.Dialogflow.AgentsPlaybook("Support", {
 *   agent: agentName,
 *   displayName: "support",
 *   goal: "Answer the user's support question.",
 * });
 * ```
 *
 * ### Updating a Playbook
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Narrow the goal
 * ```typescript
 * const playbook = yield* GCP.Dialogflow.AgentsPlaybook("Support", {
 *   agent: agentName,
 *   displayName: "support",
 *   goal: "Reset the user's password.",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsPlaybook = Resource<AgentsPlaybook>(
  "GCP.Dialogflow.AgentsPlaybook",
);

export class AgentsPlaybookNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsPlaybookNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_GOAL = "Handle the user request.";
const DEFAULT_TYPE: PlaybookType = "TASK";

const resourceName = (agent: string, playbookId: string) =>
  `${agent}/playbooks/${playbookId}`;

const stepsOf = (
  steps: dialogflow.GoogleCloudDialogflowCxV3PlaybookStepList | undefined,
): PlaybookStep[] | undefined => {
  if (steps === undefined) return undefined;
  return steps.map((step) => ({
    text: step.text,
    steps: stepsOf(step.steps),
  }));
};

const instructionOf = (
  instruction:
    | dialogflow.GoogleCloudDialogflowCxV3PlaybookInstruction
    | undefined,
): PlaybookInstruction | undefined => {
  if (instruction === undefined) return undefined;
  return {
    guidelines: instruction.guidelines,
    steps: stepsOf(instruction.steps),
  };
};

const toAttrs = (
  playbook: dialogflow.GoogleCloudDialogflowCxV3Playbook,
  project: string,
  agentHint?: string,
) => {
  const name = playbook.name ?? "";
  return {
    name,
    playbookId: lastSegment(name),
    agent: name.includes("/playbooks/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(playbook.displayName).text,
    goal: playbook.goal,
    instruction: instructionOf(playbook.instruction),
    playbookType: playbook.playbookType,
    referencedTools: [...(playbook.referencedTools ?? [])],
    referencedPlaybooks: [...(playbook.referencedPlaybooks ?? [])],
    referencedFlows: [...(playbook.referencedFlows ?? [])],
    llmModelSettings: playbook.llmModelSettings
      ? {
          model: playbook.llmModelSettings.model,
          promptText: playbook.llmModelSettings.promptText,
        }
      : undefined,
    tokenCount: playbook.tokenCount,
    createTime: playbook.createTime,
    updateTime: playbook.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsPlaybooks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooks
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.playbooks ?? [])),
      Stream.filter((playbook) => hasOwnershipMarker(playbook.displayName)),
      Stream.map((playbook) => toAttrs(playbook, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooks
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.playbooks ?? [])),
      Stream.filter((playbook) => playbook.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsPlaybookProvider = () =>
  Provider.succeed(AgentsPlaybook, {
    stables: [
      "name",
      "playbookId",
      "agent",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.playbookId ?? output?.playbookId;
      if (
        previousId !== undefined &&
        news.playbookId !== undefined &&
        news.playbookId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const agent = olds?.agent
        ? expandAgent(olds.agent, env.project, location)
        : output?.agent;
      const playbookId = yield* toResourceId(
        id,
        olds?.playbookId,
        output?.playbookId,
      );
      const name =
        output?.name ??
        (agent !== undefined ? resourceName(agent, playbookId) : "");
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
      const playbookId = yield* toResourceId(
        id,
        news.playbookId,
        output?.playbookId,
      );
      const name = output?.name ?? resourceName(agent, playbookId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const goal = news.goal ?? DEFAULT_GOAL;
      const playbookType = news.playbookType ?? DEFAULT_TYPE;
      const body: dialogflow.GoogleCloudDialogflowCxV3Playbook = {
        displayName,
        goal,
        instruction: news.instruction,
        playbookType,
        referencedTools: news.referencedTools,
        referencedPlaybooks: news.referencedPlaybooks,
        referencedFlows: news.referencedFlows,
        llmModelSettings: news.llmModelSettings,
        codeBlock: news.codeBlock,
        inputParameterDefinitions: news.inputParameterDefinitions,
        outputParameterDefinitions: news.outputParameterDefinitions,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsPlaybooks({
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
        return yield* new AgentsPlaybookNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const goalChanged = !sameText(current.goal, goal);
      const instructionChanged =
        fingerprint(instructionOf(current.instruction)) !==
        fingerprint(news.instruction);
      const typeChanged =
        (current.playbookType ?? DEFAULT_TYPE) !== playbookType;
      const toolsChanged =
        fingerprint([...(current.referencedTools ?? [])]) !==
        fingerprint(news.referencedTools);
      const playbooksChanged =
        fingerprint([...(current.referencedPlaybooks ?? [])]) !==
        fingerprint(news.referencedPlaybooks);
      const flowsChanged =
        fingerprint([...(current.referencedFlows ?? [])]) !==
        fingerprint(news.referencedFlows);
      const llmChanged =
        fingerprint(current.llmModelSettings) !==
        fingerprint(news.llmModelSettings);
      const codeChanged =
        fingerprint(current.codeBlock) !== fingerprint(news.codeBlock);
      const inputChanged =
        fingerprint(current.inputParameterDefinitions) !==
        fingerprint(news.inputParameterDefinitions);
      const outputChanged =
        fingerprint(current.outputParameterDefinitions) !==
        fingerprint(news.outputParameterDefinitions);

      if (
        displayChanged ||
        goalChanged ||
        instructionChanged ||
        typeChanged ||
        toolsChanged ||
        playbooksChanged ||
        flowsChanged ||
        llmChanged ||
        codeChanged ||
        inputChanged ||
        outputChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsPlaybooks({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            goalChanged ? "goal" : undefined,
            instructionChanged ? "instruction" : undefined,
            typeChanged ? "playbook_type" : undefined,
            toolsChanged ? "referenced_tools" : undefined,
            playbooksChanged ? "referenced_playbooks" : undefined,
            flowsChanged ? "referenced_flows" : undefined,
            llmChanged ? "llm_model_settings" : undefined,
            codeChanged ? "code_block" : undefined,
            inputChanged ? "input_parameter_definitions" : undefined,
            outputChanged ? "output_parameter_definitions" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsPlaybooks({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
