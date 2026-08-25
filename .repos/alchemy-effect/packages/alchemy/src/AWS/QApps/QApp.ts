import * as qapps from "@distilled.cloud/aws/qapps";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type AppStatus = qapps.AppStatus;
export type AppRequiredCapability = qapps.AppRequiredCapability;
export type CardInput = qapps.CardInput;

/**
 * Definition of an Amazon Q App — the ordered cards that make up the app's
 * flow plus an optional initial prompt.
 */
export interface QAppDefinition {
  /**
   * The cards that make up the Q App. Card ids must be UUIDs; dependencies
   * between cards are calculated by the service from references in prompts
   * (e.g. `@card-title`).
   */
  cards: qapps.CardInput[];
  /**
   * The initial prompt displayed when the Q App is started.
   */
  initialPrompt?: string;
}

export interface QAppProps {
  /**
   * The unique identifier of the Amazon Q Business application environment
   * instance the Q App is created in. Changing it replaces the Q App.
   */
  instanceId: string;
  /**
   * Title of the Q App.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
  /**
   * A description of the Q App.
   */
  description?: string;
  /**
   * The definition of the Q App — its cards and flow.
   */
  appDefinition: QAppDefinition;
  /**
   * Tags to associate with the Q App.
   */
  tags?: Record<string, string>;
}

export interface QApp extends Resource<
  "AWS.QApps.QApp",
  QAppProps,
  {
    /**
     * Service-assigned unique identifier of the Q App.
     */
    appId: string;
    /**
     * ARN of the Q App.
     */
    appArn: string;
    /**
     * The Q Business application environment instance the Q App belongs to.
     */
    instanceId: string;
    /**
     * The Q App's title.
     */
    title: string;
    /**
     * The Q App's description.
     */
    description: string | undefined;
    /**
     * The current version of the Q App definition.
     */
    appVersion: number;
    /**
     * Lifecycle status of the Q App (`DRAFT`, `PUBLISHED`, `DELETED`).
     */
    status: AppStatus;
    /**
     * Capabilities end users need to run the Q App (e.g. `FileUpload`).
     */
    requiredCapabilities: AppRequiredCapability[] | undefined;
    /**
     * Current tags reported for the Q App.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Q App — a lightweight, purpose-built AI app defined as a flow of
 * cards (text inputs, file uploads, LLM query cards, plugin cards) running
 * inside an Amazon Q Business application environment.
 *
 * :::caution
 * Q Apps live inside an Amazon Q Business application (pass its id as
 * `instanceId`), which itself requires IAM Identity Center. The calling
 * identity must be a user of that Q Business application.
 * :::
 * @resource
 * @section Creating Q Apps
 * @example Prompt-Driven Q App
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const summarizer = yield* AWS.QApps.QApp("Summarizer", {
 *   instanceId: qbusinessApp.applicationId,
 *   description: "Summarizes pasted text",
 *   appDefinition: {
 *     cards: [
 *       {
 *         textInput: {
 *           id: "11111111-1111-4111-8111-111111111111",
 *           title: "Source Text",
 *           type: "text-input",
 *         },
 *       },
 *       {
 *         qQuery: {
 *           id: "22222222-2222-4222-8222-222222222222",
 *           title: "Summary",
 *           type: "q-query",
 *           prompt: "Summarize the following text: @Source Text",
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example File Upload Q App
 * ```typescript
 * const analyzer = yield* AWS.QApps.QApp("DocAnalyzer", {
 *   instanceId: qbusinessApp.applicationId,
 *   appDefinition: {
 *     initialPrompt: "Upload a document to analyze",
 *     cards: [
 *       {
 *         fileUpload: {
 *           id: "33333333-3333-4333-8333-333333333333",
 *           title: "Document",
 *           type: "file-upload",
 *         },
 *       },
 *       {
 *         qQuery: {
 *           id: "44444444-4444-4444-8444-444444444444",
 *           title: "Analysis",
 *           type: "q-query",
 *           prompt: "List the key points of @Document",
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const QApp = Resource<QApp>("AWS.QApps.QApp");

const createTitle = (id: string, props: { title?: string | undefined }) =>
  props.title
    ? Effect.succeed(props.title)
    : createPhysicalName({ id, maxLength: 100 });

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* qapps
    .listTagsForResource({ resourceARN: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(response?.tags ?? {})) {
    if (value !== undefined) tags[key] = value;
  }
  return tags;
});

interface QAppState {
  attrs: QApp["Attributes"];
  observed: qapps.GetQAppOutput;
}

const readQAppById = Effect.fn(function* (instanceId: string, appId: string) {
  const observed = yield* qapps
    .getQApp({ instanceId, appId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!observed || observed.status === "DELETED") return undefined;
  const state: QAppState = {
    observed,
    attrs: {
      appId: observed.appId,
      appArn: observed.appArn,
      instanceId,
      title: observed.title,
      description: observed.description,
      appVersion: observed.appVersion,
      status: observed.status,
      requiredCapabilities: observed.requiredCapabilities?.slice(),
      tags: yield* fetchTags(observed.appArn),
    },
  };
  return state;
});

const findQAppByTitle = Effect.fn(function* (
  instanceId: string,
  title: string,
) {
  const apps = yield* qapps.listQApps.pages({ instanceId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.apps ?? [])),
  );
  const match = apps.find(
    (app) => app.title === title && app.status !== "DELETED",
  );
  if (!match?.appId) return undefined;
  return yield* readQAppById(instanceId, match.appId);
});

/**
 * Structural subset comparison: every defined field of `desired` must be
 * present (deep-equal) in `observed`. Observed cards carry service-computed
 * fields (`dependencies`, resolved `outputSource` defaults, …) that the
 * desired card input never specifies — those must not register as drift.
 */
const isSubsetOf = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((item, index) => isSubsetOf(item, observed[index]));
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return false;
    const observedRecord: Record<string, unknown> = { ...observed };
    return Object.entries(desired).every(([key, value]) =>
      isSubsetOf(value, observedRecord[key]),
    );
  }
  return desired === observed;
};

const definitionDrifted = (
  desired: QAppDefinition,
  observed: qapps.GetQAppOutput,
): boolean => {
  if (
    desired.initialPrompt !== undefined &&
    desired.initialPrompt !== observed.initialPrompt
  ) {
    return true;
  }
  return !isSubsetOf(desired.cards, observed.appDefinition.cards);
};

export const QAppProvider = () =>
  Provider.effect(
    QApp,
    Effect.gen(function* () {
      return {
        stables: ["appId", "appArn", "instanceId"],
        // Q Apps are keyed by their parent Q Business application environment
        // instance — enumeration across all instances is not meaningful here.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = output?.instanceId ?? olds?.instanceId;
          if (instanceId === undefined) return undefined;
          const state = output?.appId
            ? yield* readQAppById(instanceId, output.appId)
            : yield* findQAppByTitle(
                instanceId,
                yield* createTitle(id, olds ?? {}),
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // A Q App is bound to its Q Business application environment
          // instance at creation.
          if (olds.instanceId !== news.instanceId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(new Error("QApps QApp requires props"));
          }
          const title = yield* createTitle(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a title lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.appId
            ? yield* readQAppById(news.instanceId, output.appId)
            : yield* findQAppByTitle(news.instanceId, title);

          // Ensure — create if missing.
          if (state === undefined) {
            const created = yield* qapps.createQApp({
              instanceId: news.instanceId,
              title,
              description: news.description,
              appDefinition: {
                cards: news.appDefinition.cards,
                initialPrompt: news.appDefinition.initialPrompt,
              },
              tags: desiredTags,
            });
            yield* session.note(`Created Q App ${title} (${created.appId})`);
            state = yield* readQAppById(news.instanceId, created.appId);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created Q App ${title}`),
              );
            }
          }

          // Sync title/description/definition via UpdateQApp — only on drift.
          const observed = state.observed;
          const needsUpdate =
            title !== observed.title ||
            (news.description ?? "") !== (observed.description ?? "") ||
            definitionDrifted(news.appDefinition, observed);
          if (needsUpdate) {
            yield* qapps.updateQApp({
              instanceId: news.instanceId,
              appId: state.attrs.appId,
              title,
              description: news.description,
              appDefinition: {
                cards: news.appDefinition.cards,
                initialPrompt: news.appDefinition.initialPrompt,
              },
            });
            yield* session.note(`Updated Q App ${title}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* qapps.untagResource({
              resourceARN: state.attrs.appArn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* qapps.tagResource({
              resourceARN: state.attrs.appArn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }

          yield* session.note(state.attrs.appArn);

          const final = yield* readQAppById(news.instanceId, state.attrs.appId);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled Q App ${title}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* qapps
            .deleteQApp({
              instanceId: output.instanceId,
              appId: output.appId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
