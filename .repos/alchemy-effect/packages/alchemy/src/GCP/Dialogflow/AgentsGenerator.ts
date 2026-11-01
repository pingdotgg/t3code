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

export type GeneratorModelParameter = {
  /** Sampling temperature. */
  temperature?: number;
  /** Maximum decode steps. */
  maxDecodeSteps?: number;
  /** Top-K sampling. */
  topK?: number;
  /** Top-P (nucleus) sampling. */
  topP?: number;
};

export type GeneratorPlaceholder = {
  /** Placeholder id referenced from the prompt. */
  id?: string;
  /** Human-readable placeholder name. */
  name?: string;
};

export type GeneratorLlmModelSettings = {
  /** LLM model id. */
  model?: string;
  /** Model prompt text. */
  promptText?: string;
};

export type AgentsGeneratorProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`.
   * Immutable — changing it replaces the generator.
   */
  agent: string;
  /**
   * Generator id (the `{generator}` segment). Server-assigned when
   * omitted. Immutable — changing it replaces the generator.
   */
  generatorId?: string;
  /**
   * Location used when `agent` is an id rather than a resource name.
   * Immutable — changing it replaces the generator.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name. Generators have no labels field, so Alchemy
   * stamps ownership into this field and strips it from attributes.
   */
  displayName?: string;
  /**
   * Prompt phrase the generator fills in.
   * @default "Say hello."
   */
  promptText?: string;
  /** Language code for the prompt (`en`, `en-US`, …). */
  languageCode?: string;
  /** Decoding parameters. */
  modelParameter?: GeneratorModelParameter;
  /** Placeholders referenced from `promptText`. */
  placeholders?: GeneratorPlaceholder[];
  /** LLM model settings. */
  llmModelSettings?: GeneratorLlmModelSettings;
};

export type AgentsGenerator = Resource<
  "GCP.Dialogflow.AgentsGenerator",
  AgentsGeneratorProps,
  {
    /** Full resource name `.../agents/{agent}/generators/{generator}`. */
    name: string;
    /** Generator id (last path segment). */
    generatorId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Prompt text. */
    promptText: string | undefined;
    /** Decoding parameters. */
    modelParameter: GeneratorModelParameter | undefined;
    /** Placeholders. */
    placeholders: GeneratorPlaceholder[] | undefined;
    /** LLM model settings. */
    llmModelSettings: GeneratorLlmModelSettings | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX generator that produces LLM-backed response text.
 *
 * Generators have no labels field — Alchemy stamps ownership into
 * `displayName` so `list` / nuke can find them. Parent agent and id are
 * immutable. Display name, prompt, model parameters, placeholders, and
 * LLM settings update in place.
 *
 * ### Creating a Generator
 * **Example:** Prompt generator
 * ```typescript
 * const generator = yield* GCP.Dialogflow.AgentsGenerator("Greeting", {
 *   agent: agentName,
 *   displayName: "greeting",
 *   promptText: "Greet the user by name.",
 * });
 * ```
 *
 * ### Updating a Generator
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Change the prompt
 * ```typescript
 * const generator = yield* GCP.Dialogflow.AgentsGenerator("Greeting", {
 *   agent: agentName,
 *   displayName: "greeting",
 *   promptText: "Greet the user warmly.",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsGenerator = Resource<AgentsGenerator>(
  "GCP.Dialogflow.AgentsGenerator",
);

export class AgentsGeneratorNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsGeneratorNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_PROMPT = "Say hello.";

const resourceName = (agent: string, generatorId: string) =>
  `${agent}/generators/${generatorId}`;

const modelParameterOf = (
  parameter:
    | dialogflow.GoogleCloudDialogflowCxV3GeneratorModelParameter
    | undefined,
): GeneratorModelParameter | undefined => {
  if (parameter === undefined) return undefined;
  return {
    temperature: parameter.temperature,
    maxDecodeSteps: parameter.maxDecodeSteps,
    topK: parameter.topK,
    topP: parameter.topP,
  };
};

const placeholdersOf = (
  placeholders:
    | dialogflow.GoogleCloudDialogflowCxV3GeneratorPlaceholderList
    | undefined,
): GeneratorPlaceholder[] | undefined => {
  if (placeholders === undefined) return undefined;
  return placeholders.map((placeholder) => ({
    id: placeholder.id,
    name: placeholder.name,
  }));
};

const llmSettingsOf = (
  settings: dialogflow.GoogleCloudDialogflowCxV3LlmModelSettings | undefined,
): GeneratorLlmModelSettings | undefined => {
  if (settings === undefined) return undefined;
  return { model: settings.model, promptText: settings.promptText };
};

const toAttrs = (
  generator: dialogflow.GoogleCloudDialogflowCxV3Generator,
  project: string,
  agentHint?: string,
) => {
  const name = generator.name ?? "";
  const parsed = parseOwnership(generator.displayName);
  return {
    name,
    generatorId: lastSegment(name),
    agent: name.includes("/generators/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parsed.text,
    promptText: generator.promptText?.text,
    modelParameter: modelParameterOf(generator.modelParameter),
    placeholders: placeholdersOf(generator.placeholders),
    llmModelSettings: llmSettingsOf(generator.llmModelSettings),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsGenerators({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsGenerators
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.generators ?? [])),
      Stream.filter((generator) => hasOwnershipMarker(generator.displayName)),
      Stream.map((generator) => toAttrs(generator, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsGenerators
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.generators ?? [])),
      Stream.filter((generator) => generator.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsGeneratorProvider = () =>
  Provider.succeed(AgentsGenerator, {
    stables: ["name", "generatorId", "agent", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.generatorId ?? output?.generatorId;
      if (
        previousId !== undefined &&
        news.generatorId !== undefined &&
        news.generatorId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
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
      const generatorId = yield* toResourceId(
        id,
        olds?.generatorId,
        output?.generatorId,
      );
      const name =
        output?.name ??
        (agent !== undefined ? resourceName(agent, generatorId) : "");
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
      const generatorId = yield* toResourceId(
        id,
        news.generatorId,
        output?.generatorId,
      );
      const name = output?.name ?? resourceName(agent, generatorId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const promptText = news.promptText ?? DEFAULT_PROMPT;
      const body: dialogflow.GoogleCloudDialogflowCxV3Generator = {
        displayName,
        promptText: { text: promptText },
        modelParameter: news.modelParameter,
        placeholders: news.placeholders,
        llmModelSettings: news.llmModelSettings,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsGenerators({
            parent: agent,
            languageCode: news.languageCode,
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
        return yield* new AgentsGeneratorNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const promptChanged = !sameText(current.promptText?.text, promptText);
      const modelChanged =
        fingerprint(modelParameterOf(current.modelParameter)) !==
        fingerprint(news.modelParameter);
      const placeholdersChanged =
        fingerprint(placeholdersOf(current.placeholders)) !==
        fingerprint(news.placeholders);
      const llmChanged =
        fingerprint(llmSettingsOf(current.llmModelSettings)) !==
        fingerprint(news.llmModelSettings);

      if (
        displayChanged ||
        promptChanged ||
        modelChanged ||
        placeholdersChanged ||
        llmChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsGenerators({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            promptChanged ? "prompt_text" : undefined,
            modelChanged ? "model_parameter" : undefined,
            placeholdersChanged ? "placeholders" : undefined,
            llmChanged ? "llm_model_settings" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsGenerators({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
