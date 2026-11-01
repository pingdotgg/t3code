import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  collectionParent,
  DEFAULT_LOCATION,
  encodeOwnership,
  encodeOwnershipLine,
  expandAgent,
  fingerprint,
  hasOwnershipMarker,
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

export type IntentTrainingPhrasePart = {
  /** Parameter id this part annotates. */
  parameterId?: string;
  /** Text of this part. */
  text?: string;
};

export type IntentTrainingPhrase = {
  /** Ordered parts that concatenate to the phrase. */
  parts?: IntentTrainingPhrasePart[];
  /** Training phrase id. Output only when omitted. */
  id?: string;
  /** How many times this phrase is repeated during training. */
  repeatCount?: number;
};

export type IntentParameter = {
  /** Unique parameter id. */
  id?: string;
  /** Entity type (`projects/-/locations/-/agents/-/entityTypes/sys.date`). */
  entityType?: string;
  /** Redact the parameter in logs. */
  redact?: boolean;
  /** Whether the parameter is a list. */
  isList?: boolean;
};

export type AgentsIntentProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`.
   * Immutable — changing it replaces the intent.
   */
  agent: string;
  /**
   * Intent id (the `{intent}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the intent.
   */
  intentId?: string;
  /**
   * Location used when `agent` is an id rather than a resource name.
   * Immutable — changing it replaces the intent.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name unique within the agent. Alchemy stamps
   * ownership into this field and strips it from attributes.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /** Training phrases. */
  trainingPhrases?: IntentTrainingPhrase[];
  /** Intent parameters. */
  parameters?: IntentParameter[];
  /**
   * Matching priority. Higher values match first. `0` or negative
   * disables the intent.
   */
  priority?: number;
  /**
   * Whether this is the fallback intent.
   * @default false
   */
  isFallback?: boolean;
  /**
   * Human-readable description. Alchemy also stamps ownership here so
   * `list` / nuke can find the intent if labels are stripped.
   */
  description?: string;
  /** DTMF pattern associated with this intent. */
  dtmfPattern?: string;
  /** Language code for training phrases. */
  languageCode?: string;
};

export type AgentsIntent = Resource<
  "GCP.Dialogflow.AgentsIntent",
  AgentsIntentProps,
  {
    /** Full resource name `.../agents/{agent}/intents/{intent}`. */
    name: string;
    /** Intent id (last path segment). */
    intentId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Training phrases. */
    trainingPhrases: IntentTrainingPhrase[] | undefined;
    /** Intent parameters. */
    parameters: IntentParameter[] | undefined;
    /** Matching priority. */
    priority: number | undefined;
    /** Whether this is the fallback intent. */
    isFallback: boolean;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** DTMF pattern. */
    dtmfPattern: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX intent (training phrases plus parameters).
 *
 * Alchemy ownership is stored in labels, `displayName`, and
 * `description` so `list` / nuke can find the intent. Parent agent and
 * id are immutable. Display name, labels, training phrases, parameters,
 * priority, fallback flag, description, and DTMF pattern update in
 * place.
 *
 * ### Creating an Intent
 * **Example:** Greeting intent
 * ```typescript
 * const intent = yield* GCP.Dialogflow.AgentsIntent("Hello", {
 *   agent: agentName,
 *   displayName: "hello",
 *   trainingPhrases: [
 *     { parts: [{ text: "hello" }], repeatCount: 1 },
 *     { parts: [{ text: "hi there" }], repeatCount: 1 },
 *   ],
 *   labels: { env: "test" },
 * });
 * ```
 *
 * ### Updating an Intent
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Add a training phrase
 * ```typescript
 * const intent = yield* GCP.Dialogflow.AgentsIntent("Hello", {
 *   agent: agentName,
 *   displayName: "hello",
 *   trainingPhrases: [
 *     { parts: [{ text: "hello" }], repeatCount: 1 },
 *     { parts: [{ text: "good morning" }], repeatCount: 1 },
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsIntent = Resource<AgentsIntent>(
  "GCP.Dialogflow.AgentsIntent",
);

export class AgentsIntentNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsIntentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (agent: string, intentId: string) =>
  `${agent}/intents/${intentId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const phrasesOf = (
  phrases:
    | dialogflow.GoogleCloudDialogflowCxV3IntentTrainingPhraseList
    | undefined,
): IntentTrainingPhrase[] | undefined => {
  if (phrases === undefined) return undefined;
  return phrases.map((phrase) => ({
    parts: phrase.parts?.map((part) => ({
      parameterId: part.parameterId,
      text: part.text,
    })),
    repeatCount: phrase.repeatCount,
  }));
};

const parametersOf = (
  parameters:
    | dialogflow.GoogleCloudDialogflowCxV3IntentParameterList
    | undefined,
): IntentParameter[] | undefined => {
  if (parameters === undefined) return undefined;
  return parameters.map((parameter) => ({
    id: parameter.id,
    entityType: parameter.entityType,
    redact: parameter.redact,
    isList: parameter.isList,
  }));
};

const toAttrs = (
  intent: dialogflow.GoogleCloudDialogflowCxV3Intent,
  project: string,
  agentHint?: string,
) => {
  const name = intent.name ?? "";
  return {
    name,
    intentId: lastSegment(name),
    agent: name.includes("/intents/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(intent.displayName).text,
    labels: userLabels(intent.labels),
    trainingPhrases: phrasesOf(intent.trainingPhrases),
    parameters: parametersOf(intent.parameters),
    priority: intent.priority,
    isFallback: intent.isFallback === true,
    description: parseOwnership(intent.description).text,
    dtmfPattern: intent.dtmfPattern,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsIntents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isOwnedIntent = (intent: dialogflow.GoogleCloudDialogflowCxV3Intent) =>
  hasOwnershipMarker(intent.displayName) ||
  hasOwnershipMarker(intent.description) ||
  Object.keys(intent.labels ?? {}).some((key) => key.startsWith("alchemy-"));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsIntents
    .pages({ parent, pageSize: 100, intentView: "INTENT_VIEW_FULL" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.intents ?? [])),
      Stream.filter(isOwnedIntent),
      Stream.map((intent) => toAttrs(intent, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsIntents
    .pages({ parent, pageSize: 100, intentView: "INTENT_VIEW_PARTIAL" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.intents ?? [])),
      Stream.filter((intent) => intent.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsIntentProvider = () =>
  Provider.succeed(AgentsIntent, {
    stables: ["name", "intentId", "agent", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.intentId ?? output?.intentId;
      if (
        previousId !== undefined &&
        news.intentId !== undefined &&
        news.intentId !== previousId
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
      const intentId = yield* toResourceId(
        id,
        olds?.intentId,
        output?.intentId,
      );
      const name =
        output?.name ??
        (agent !== undefined ? resourceName(agent, intentId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined && agent !== undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          agent,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, agent);
      const labeled = yield* hasAlchemyLabels(id, tagRecord(existing.labels));
      const named = yield* ownedByAlchemy(id, existing.displayName);
      const described = yield* ownedByAlchemy(id, existing.description);
      return labeled || named || described ? attrs : Unowned(attrs);
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
      const intentId = yield* toResourceId(id, news.intentId, output?.intentId);
      const name = output?.name ?? resourceName(agent, intentId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const description = encodeOwnership(ownership, news.description);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...ownership,
      };
      const isFallback = news.isFallback === true;
      const body: dialogflow.GoogleCloudDialogflowCxV3Intent = {
        displayName,
        labels: desiredLabels,
        trainingPhrases: news.trainingPhrases,
        parameters: news.parameters,
        priority: news.priority,
        isFallback,
        description,
        dtmfPattern: news.dtmfPattern,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsIntents({
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
        return yield* new AgentsIntentNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const phrasesChanged =
        fingerprint(phrasesOf(current.trainingPhrases)) !==
        fingerprint(news.trainingPhrases);
      const parametersChanged =
        fingerprint(parametersOf(current.parameters)) !==
        fingerprint(news.parameters);
      const priorityChanged = (current.priority ?? 0) !== (news.priority ?? 0);
      const fallbackChanged = (current.isFallback === true) !== isFallback;
      const descriptionChanged = (current.description ?? "") !== description;
      const dtmfChanged = !sameText(current.dtmfPattern, news.dtmfPattern);

      if (
        displayChanged ||
        labelsChanged ||
        phrasesChanged ||
        parametersChanged ||
        priorityChanged ||
        fallbackChanged ||
        descriptionChanged ||
        dtmfChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsIntents({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            labelsChanged ? "labels" : undefined,
            phrasesChanged ? "training_phrases" : undefined,
            parametersChanged ? "parameters" : undefined,
            priorityChanged ? "priority" : undefined,
            fallbackChanged ? "is_fallback" : undefined,
            descriptionChanged ? "description" : undefined,
            dtmfChanged ? "dtmf_pattern" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsIntents({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
