import { type KompasError, MessageId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { KompasSettingsStore } from "../../../kompas/KompasSettingsStore.ts";
import { LearningService, type NewCard } from "../../../kompas/LearningService.ts";
import { MemoryService, projectScope } from "../../../kompas/MemoryService.ts";
import { PluginProxy } from "../../../kompas/PluginProxy.ts";
import { PluginStore } from "../../../kompas/PluginStore.ts";
import { ThreadFiles } from "../../../kompas/ThreadFiles.ts";
import { ThreadProfiles } from "../../../kompas/ThreadProfiles.ts";
import { type WidgetName, WidgetPublisher } from "../../../kompas/WidgetDocument.ts";
import { WorkstreamStore } from "../../../kompas/WorkstreamStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../../../orchestration-v2/ThreadSearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { KompasToolkit } from "./tools.ts";

const SHOWN = "Shown to the user in the thread. Don't repeat its contents.";
const MAX_DUE_CARDS = 40;
const MAX_MESSAGE_CHARS = 2_000;

const failure = (code: "invalid_request" | "orchestration_error", message: string) =>
  new OrchestratorMcpFailure({ code, message });

const toFailure = (error: KompasError) =>
  failure(
    error.reason === "storage" || error.reason === "unreachable"
      ? "orchestration_error"
      : "invalid_request",
    error.message,
  );

const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const { thread: record } = yield* threads
    .getThreadRecords(thread.threadId, [])
    .pipe(Effect.mapError(() => failure("orchestration_error", "Could not read this thread.")));
  return record;
});

const publish = Effect.fn("KompasToolkit.publish")(function* (
  tool: string,
  widget: WidgetName,
  data: unknown,
) {
  const thread = yield* callerThread;
  const publisher = yield* WidgetPublisher;
  return yield* publisher
    .publish({ threadId: thread.id, tool, widget, data })
    .pipe(Effect.mapError(toFailure));
});

/** A widget that only draws the arguments it was called with. */
const draws = <P>(tool: string, widget: WidgetName, check?: (params: P) => string | undefined) =>
  McpToolAccess.actsAsCaller((params: P) =>
    Effect.gen(function* () {
      const problem = check?.(params);
      if (problem !== undefined) return yield* failure("invalid_request", problem);
      return { widget: yield* publish(tool, widget, params), message: SHOWN };
    }),
  );

const showDeck = Effect.fn("KompasToolkit.showDeck")(function* (
  tool: string,
  deck: { readonly id: string; readonly title: string; readonly cardCount: number },
) {
  return {
    deckId: deck.id,
    cardCount: deck.cardCount,
    widget: yield* publish(tool, "flashcards", { deckId: deck.id, title: deck.title }),
    message: SHOWN,
  };
});

const ownWorkstream = Effect.gen(function* () {
  const thread = yield* callerThread;
  const profiles = yield* ThreadProfiles;
  const { workstream } = yield* profiles.membership(thread);
  return workstream === null
    ? yield* failure("invalid_request", "This conversation is not part of a project.")
    : { thread, workstream };
});

const coordinated = Effect.gen(function* () {
  const thread = yield* callerThread;
  const store = yield* WorkstreamStore;
  const workstream = yield* store.byCoordinator(thread.id).pipe(Effect.mapError(toFailure));
  return (
    workstream ??
    (yield* failure("invalid_request", "Only a project's coordinator can use this tool."))
  );
});

const threadPlugins = Effect.gen(function* () {
  const thread = yield* callerThread;
  const store = yield* PluginStore;
  const enabled = yield* store.forThread(thread.id).pipe(Effect.mapError(toFailure));
  return yield* Effect.forEach(enabled, (plugin) =>
    store.get(plugin.id).pipe(Effect.mapError(toFailure)),
  );
});

const handlers = {
  quiz: draws<{
    readonly questions: ReadonlyArray<{
      readonly options: ReadonlyArray<string>;
      readonly answer: number;
    }>;
  }>("quiz", "quiz", ({ questions }) => {
    const wrong = questions.findIndex(
      ({ options, answer }) => answer < 0 || answer >= options.length,
    );
    return wrong === -1
      ? undefined
      : `Question ${wrong + 1}: answer must be the index of one of its options.`;
  }),
  chart: draws<{
    readonly type: string;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly series: ReadonlyArray<{
      readonly values?: ReadonlyArray<number | null> | undefined;
      readonly points?: ReadonlyArray<ReadonlyArray<number>> | undefined;
    }>;
  }>("chart", "chart", ({ type, labels, series }) =>
    type === "scatter"
      ? series.some(({ points }) => points === undefined)
        ? "scatter needs points ([x, y]) in every series."
        : undefined
      : labels === undefined || series.some(({ values }) => values?.length !== labels.length)
        ? `${type} needs labels, and as many values in every series.`
        : undefined,
  ),
  diagram: draws("diagram", "diagram"),
  map: draws<{
    readonly pins?: ReadonlyArray<unknown> | undefined;
    readonly routes?: ReadonlyArray<unknown> | undefined;
    readonly areas?: ReadonlyArray<unknown> | undefined;
  }>("map", "map", ({ pins, routes, areas }) =>
    (pins?.length ?? 0) + (routes?.length ?? 0) + (areas?.length ?? 0) === 0
      ? "A map needs at least one pin, route or area."
      : undefined,
  ),
  math: draws("math", "math"),
  timeline: draws("timeline", "timeline"),
  table: draws("table", "table"),
  choices: draws("choices", "choices"),
  flashcards_create_deck: McpToolAccess.actsAsCaller(
    (input: { readonly title: string; readonly cards: ReadonlyArray<NewCard> }) =>
      Effect.gen(function* () {
        const thread = yield* callerThread;
        const learning = yield* LearningService;
        const deck = yield* learning
          .createDeck({ ...input, threadId: thread.id })
          .pipe(Effect.mapError(toFailure));
        return yield* showDeck("flashcards_create_deck", deck);
      }),
  ),
  flashcards_add: McpToolAccess.actsAsCaller(
    (input: { readonly deckId: string; readonly cards: ReadonlyArray<NewCard> }) =>
      Effect.gen(function* () {
        const thread = yield* callerThread;
        const learning = yield* LearningService;
        const deck = yield* learning
          .addCards({ ...input, threadId: thread.id })
          .pipe(Effect.mapError(toFailure));
        return yield* showDeck("flashcards_add", deck);
      }),
  ),
  flashcards_list_decks: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const learning = yield* LearningService;
      const decks = yield* learning.decks.pipe(Effect.mapError(toFailure));
      return {
        decks: decks.map(({ id, title, cardCount, dueCount }) => ({
          deckId: id,
          title,
          cardCount,
          dueCount,
        })),
      };
    }),
  ),
  flashcards_due: McpToolAccess.readsAsCaller(
    ({ deckId }: { readonly deckId?: string | undefined }) =>
      Effect.gen(function* () {
        const learning = yield* LearningService;
        const cards = yield* learning
          .cards({ deckId, dueOnly: true })
          .pipe(Effect.mapError(toFailure));
        return {
          total: cards.length,
          cards: cards.slice(0, MAX_DUE_CARDS).map(({ id, deckTitle, front, back }) => ({
            cardId: id,
            deck: deckTitle,
            front,
            back,
          })),
        };
      }),
  ),
  study_stats: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const learning = yield* LearningService;
      const { weakest, ...stats } = yield* learning.stats.pipe(Effect.mapError(toFailure));
      return {
        ...stats,
        weakest: weakest.map(({ deckTitle, front, lapses }) => ({
          deck: deckTitle,
          front,
          lapses,
        })),
      };
    }),
  ),
  memory: McpToolAccess.actsAsCaller(
    (input: {
      readonly action: "add" | "patch" | "remove";
      readonly target: "user" | "notes" | "project";
      readonly id?: string | undefined;
      readonly text?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const thread = yield* callerThread;
        const scope =
          input.target === "project"
            ? projectScope((yield* ownWorkstream).workstream.id)
            : input.target;
        const memory = yield* MemoryService;
        const { id, text } = input;
        const change =
          input.action === "add"
            ? text === undefined
              ? undefined
              : ({ action: "add", scope, text } as const)
            : id === undefined
              ? undefined
              : input.action === "remove"
                ? ({ action: "remove", scope, id } as const)
                : text === undefined
                  ? undefined
                  : ({ action: "patch", scope, id, text } as const);
        if (change === undefined) {
          return yield* failure(
            "invalid_request",
            "add needs text; patch needs id and text; remove needs id.",
          );
        }
        const result = yield* memory
          .applyFromModel(change, { model: thread.modelSelection.model, threadId: thread.id })
          .pipe(Effect.mapError(toFailure));
        const widget = yield* publish("memory", "memory", {
          id: result.entry.id,
          text: result.entry.text,
          status: result.status,
          action: input.action,
        });
        return { status: result.status, id: result.entry.id, usage: result.usage, widget };
      }),
  ),
  session_search: McpToolAccess.readsAsCaller(
    (input: {
      readonly query?: string | undefined;
      readonly threadId?: string | undefined;
      readonly messageId?: string | undefined;
      readonly around?: number | undefined;
    }) =>
      Effect.gen(function* () {
        const settings = yield* KompasSettingsStore;
        const { memorySearchEnabled } = yield* settings.get.pipe(Effect.mapError(toFailure));
        if (!memorySearchEnabled) {
          return yield* failure(
            "invalid_request",
            "The user turned off searching past conversations.",
          );
        }
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const unreadable = () => failure("invalid_request", "No such conversation.");
        if (input.threadId !== undefined) {
          const { messages } = yield* threads
            .getThreadRecords(ThreadId.make(input.threadId), ["messages"])
            .pipe(Effect.mapError(unreadable));
          const around = Math.min(20, Math.max(1, input.around ?? 6));
          const hit =
            input.messageId === undefined
              ? messages.length - 1
              : messages.findIndex((message) => message.id === MessageId.make(input.messageId!));
          const center = hit === -1 ? messages.length - 1 : hit;
          return {
            messages: messages
              .slice(Math.max(0, center - around), center + around + 1)
              .map((message) => ({
                messageId: message.id,
                role: message.role,
                date: DateTime.formatIso(message.createdAt),
                text: message.text.slice(0, MAX_MESSAGE_CHARS),
              })),
          };
        }
        if (input.query === undefined) {
          const recent = yield* threads
            .listProjectThreads({ includeSubagents: false })
            .pipe(Effect.mapError(unreadable));
          return {
            conversations: recent.slice(0, 15).map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              date: DateTime.formatIso(thread.updatedAt),
            })),
          };
        }
        const search = yield* ThreadSearch;
        const { matches } = yield* search
          .searchThreads({ query: input.query, limit: 10 })
          .pipe(Effect.mapError(() => failure("orchestration_error", "Search failed.")));
        return {
          conversations: matches.map((match) => ({
            threadId: match.threadId,
            title: match.title,
            ...(match.snippet === undefined ? {} : { snippet: match.snippet }),
            date: match.messageCreatedAt ?? null,
          })),
        };
      }),
  ),
  plugin_tools: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const proxy = yield* PluginProxy;
      const plugins = yield* threadPlugins;
      const unavailable: Array<string> = [];
      const tools = yield* Effect.forEach(plugins, (plugin) =>
        proxy.listTools(plugin).pipe(
          Effect.map((listed) =>
            listed.map((tool) => ({
              plugin: plugin.name,
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema as unknown,
            })),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              unavailable.push(error.message);
              return [];
            }),
          ),
        ),
      );
      return { tools: tools.flat(), unavailable };
    }),
  ),
  plugin_call: McpToolAccess.actsAsCaller(
    (input: {
      readonly plugin: string;
      readonly name: string;
      readonly arguments?: Readonly<Record<string, unknown>> | undefined;
    }) =>
      Effect.gen(function* () {
        const proxy = yield* PluginProxy;
        const plugin = (yield* threadPlugins).find(({ name }) => name === input.plugin);
        if (plugin === undefined) {
          return yield* failure("invalid_request", `No plugin named ${input.plugin} here.`);
        }
        const result = yield* proxy
          .callTool(plugin, { name: input.name, arguments: { ...input.arguments } })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { content: Array.isArray(result.content) ? result.content : [] };
      }),
  ),
  suggest_threads: McpToolAccess.actsAsCaller(
    (input: {
      readonly threads: ReadonlyArray<{ readonly title: string; readonly task: string }>;
    }) =>
      Effect.gen(function* () {
        const workstream = yield* coordinated;
        const store = yield* WorkstreamStore;
        yield* store.addSuggestions(workstream.id, input.threads).pipe(Effect.mapError(toFailure));
        return {
          widget: yield* publish("suggest_threads", "suggestions", {
            workstreamId: workstream.id,
            threads: input.threads,
          }),
          message: SHOWN,
        };
      }),
  ),
  ask_decision: McpToolAccess.actsAsCaller(
    (input: { readonly question: string; readonly options: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const workstream = yield* coordinated;
        const store = yield* WorkstreamStore;
        yield* store.addDecision(workstream.id, input).pipe(Effect.mapError(toFailure));
        return {
          widget: yield* publish("ask_decision", "decision", {
            workstreamId: workstream.id,
            ...input,
          }),
          message: SHOWN,
        };
      }),
  ),
  file_read: McpToolAccess.readsAsCaller(
    (input: { readonly path: string; readonly offset?: number | undefined }) =>
      Effect.gen(function* () {
        const thread = yield* callerThread;
        const files = yield* ThreadFiles;
        return yield* files
          .read({ thread, path: input.path, offset: input.offset ?? 0 })
          .pipe(Effect.mapError(toFailure));
      }),
  ),
  project_library_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { workstream } = yield* ownWorkstream;
      const store = yield* WorkstreamStore;
      const items = yield* store.library(workstream.id).pipe(Effect.mapError(toFailure));
      return { items: items.map(({ id, kind, title, content }) => ({ id, kind, title, content })) };
    }),
  ),
  project_library_add: McpToolAccess.actsAsCaller(
    (input: {
      readonly kind: "file" | "deck" | "note";
      readonly title: string;
      readonly content: string;
    }) =>
      Effect.gen(function* () {
        const { thread, workstream } = yield* ownWorkstream;
        const store = yield* WorkstreamStore;
        const { id } = yield* store
          .addLibraryItem({ ...input, workstreamId: workstream.id, threadId: thread.id })
          .pipe(Effect.mapError(toFailure));
        return { id };
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof KompasToolkit.tools>;

export const layer = McpToolAccess.toLayer(KompasToolkit, handlers);
