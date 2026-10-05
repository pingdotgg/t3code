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
  encodeOwnership,
  encodeOwnershipLine,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  sameText,
  toResourceId,
  retryQuota,
} from "./internal.ts";

export type ExampleConversationState =
  | "OUTPUT_STATE_UNSPECIFIED"
  | "OUTPUT_STATE_OK"
  | "OUTPUT_STATE_CANCELLED"
  | "OUTPUT_STATE_FAILED"
  | "OUTPUT_STATE_ESCALATED"
  | "OUTPUT_STATE_PENDING";

export type ExampleAction = {
  /** User utterance. */
  userUtterance?: { text?: string };
  /** Agent utterance. */
  agentUtterance?: { text?: string };
  /** Tool use. */
  toolUse?: {
    tool?: string;
    action?: string;
    displayName?: string;
  };
  /** Playbook invocation. */
  playbookInvocation?: {
    playbook?: string;
    displayName?: string;
  };
  /** Flow invocation. */
  flowInvocation?: {
    flow?: string;
    displayName?: string;
  };
};

export type AgentsPlaybooksExampleProps = {
  /**
   * Parent playbook resource name
   * `projects/{project}/locations/{location}/agents/{agent}/playbooks/{playbook}`.
   * Immutable — changing it replaces the example.
   */
  playbook: string;
  /**
   * Example id (the `{example}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the example.
   */
  exampleId?: string;
  /**
   * Human-readable name. Examples have no labels field, so Alchemy
   * stamps ownership into `displayName` and `description`.
   */
  displayName?: string;
  /**
   * End state of the example conversation.
   * @default "OUTPUT_STATE_OK"
   */
  conversationState?: ExampleConversationState | (string & {});
  /**
   * Ordered conversation actions. Defaults to a single user utterance
   * followed by an agent utterance.
   */
  actions?: ExampleAction[];
  /** Human-readable description. */
  description?: string;
  /** Language code (`en`, `en-US`, …). */
  languageCode?: string;
  /** Preceding conversation summary used as playbook input. */
  playbookInput?: { precedingConversationSummary?: string };
  /** Playbook output summary. */
  playbookOutput?: { executionSummary?: string };
};

export type AgentsPlaybooksExample = Resource<
  "GCP.Dialogflow.AgentsPlaybooksExample",
  AgentsPlaybooksExampleProps,
  {
    /** Full resource name `.../playbooks/{playbook}/examples/{example}`. */
    name: string;
    /** Example id (last path segment). */
    exampleId: string;
    /** Parent playbook resource name. */
    playbook: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Conversation end state. */
    conversationState: string | undefined;
    /** Conversation actions. */
    actions: ExampleAction[] | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Language code. */
    languageCode: string | undefined;
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
 * A Dialogflow CX playbook example (few-shot conversation).
 *
 * Examples have no labels field — Alchemy stamps ownership into
 * `displayName` and `description` so `list` / nuke can find them. Parent
 * playbook and id are immutable. Display name, conversation state,
 * actions, and description update in place.
 *
 * ### Creating an Example
 * **Example:** Greeting conversation
 * ```typescript
 * const example = yield* GCP.Dialogflow.AgentsPlaybooksExample("Hello", {
 *   playbook: playbook.name,
 *   displayName: "hello",
 *   conversationState: "OUTPUT_STATE_OK",
 *   actions: [
 *     { userUtterance: { text: "hello" } },
 *     { agentUtterance: { text: "Hi, how can I help?" } },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsPlaybooksExample = Resource<AgentsPlaybooksExample>(
  "GCP.Dialogflow.AgentsPlaybooksExample",
);

export class AgentsPlaybooksExampleNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsPlaybooksExampleNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_STATE: ExampleConversationState = "OUTPUT_STATE_OK";
const DEFAULT_ACTIONS: ExampleAction[] = [
  { userUtterance: { text: "hello" } },
  { agentUtterance: { text: "Hi, how can I help?" } },
];

const resourceName = (playbook: string, exampleId: string) =>
  `${playbook}/examples/${exampleId}`;

const actionsOf = (
  actions: dialogflow.GoogleCloudDialogflowCxV3ActionList | undefined,
): ExampleAction[] | undefined => {
  if (actions === undefined) return undefined;
  return actions.map((action) => ({
    userUtterance: action.userUtterance
      ? { text: action.userUtterance.text }
      : undefined,
    agentUtterance: action.agentUtterance
      ? { text: action.agentUtterance.text }
      : undefined,
    toolUse: action.toolUse
      ? {
          tool: action.toolUse.tool,
          action: action.toolUse.action,
          displayName: action.toolUse.displayName,
        }
      : undefined,
    playbookInvocation: action.playbookInvocation
      ? {
          playbook: action.playbookInvocation.playbook,
          displayName: action.playbookInvocation.displayName,
        }
      : undefined,
    flowInvocation: action.flowInvocation
      ? {
          flow: action.flowInvocation.flow,
          displayName: action.flowInvocation.displayName,
        }
      : undefined,
  }));
};

const toAttrs = (
  example: dialogflow.GoogleCloudDialogflowCxV3Example,
  project: string,
  playbookHint?: string,
) => {
  const name = example.name ?? "";
  return {
    name,
    exampleId: lastSegment(name),
    playbook: name.includes("/examples/")
      ? collectionParent(name, "playbooks")
      : (playbookHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(example.displayName).text,
    conversationState: example.conversationState,
    actions: actionsOf(example.actions),
    description: parseOwnership(example.description).text,
    languageCode: example.languageCode,
    tokenCount: example.tokenCount,
    createTime: example.createTime,
    updateTime: example.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsPlaybooksExamples({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooksExamples
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.examples ?? [])),
      Stream.filter(
        (example) =>
          hasOwnershipMarker(example.displayName) ||
          hasOwnershipMarker(example.description),
      ),
      Stream.map((example) => toAttrs(example, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listPlaybooks = (agent: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooks
    .pages({ parent: agent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.playbooks ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooksExamples
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.examples ?? [])),
      Stream.filter((example) => example.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsPlaybooksExampleProvider = () =>
  Provider.succeed(AgentsPlaybooksExample, {
    stables: [
      "name",
      "exampleId",
      "playbook",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.playbook ?? output?.playbook;
      if (previousParent !== undefined && news.playbook !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.exampleId ?? output?.exampleId;
      if (
        previousId !== undefined &&
        news.exampleId !== undefined &&
        news.exampleId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const playbook = olds?.playbook ?? output?.playbook;
      const exampleId = yield* toResourceId(
        id,
        olds?.exampleId,
        output?.exampleId,
      );
      const name =
        output?.name ??
        (playbook !== undefined ? resourceName(playbook, exampleId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined && playbook !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          playbook,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, playbook);
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
          (agent) =>
            Effect.gen(function* () {
              const playbooks = yield* listPlaybooks(agent.name);
              const examples = yield* Effect.forEach(
                playbooks,
                (playbook) =>
                  playbook.name
                    ? listAt(playbook.name, env.project)
                    : Effect.succeed([]),
                { concurrency: 4 },
              );
              return examples.flat();
            }),
          { concurrency: 2 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const playbook = news.playbook;
      const exampleId = yield* toResourceId(
        id,
        news.exampleId,
        output?.exampleId,
      );
      const name = output?.name ?? resourceName(playbook, exampleId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const description = encodeOwnership(ownership, news.description);
      const conversationState = news.conversationState ?? DEFAULT_STATE;
      const actions = news.actions ?? DEFAULT_ACTIONS;
      const body: dialogflow.GoogleCloudDialogflowCxV3Example = {
        displayName,
        description,
        conversationState,
        actions,
        languageCode: news.languageCode,
        playbookInput: news.playbookInput,
        playbookOutput: news.playbookOutput,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(playbook, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsPlaybooksExamples({
            parent: playbook,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(playbook, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsPlaybooksExampleNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged = (current.description ?? "") !== description;
      const stateChanged =
        (current.conversationState ?? DEFAULT_STATE) !== conversationState;
      const actionsChanged =
        fingerprint(actionsOf(current.actions)) !== fingerprint(actions);
      const languageChanged = !sameText(
        current.languageCode,
        news.languageCode,
      );
      const inputChanged =
        fingerprint(current.playbookInput) !== fingerprint(news.playbookInput);
      const outputChanged =
        fingerprint(current.playbookOutput) !==
        fingerprint(news.playbookOutput);

      if (
        displayChanged ||
        descriptionChanged ||
        stateChanged ||
        actionsChanged ||
        languageChanged ||
        inputChanged ||
        outputChanged
      ) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsPlaybooksExamples({
            // Repeated fields named in an update mask (`actions`) are
            // silently ignored; the body is complete, so replace it whole.
            name: currentName,
            body: { ...body, name: currentName },
          });
      }

      return toAttrs(current, env.project, playbook);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsPlaybooksExamples({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
