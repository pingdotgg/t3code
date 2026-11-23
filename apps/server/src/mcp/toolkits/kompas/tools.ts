import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { LearningService } from "../../../kompas/LearningService.ts";
import { MemoryService } from "../../../kompas/MemoryService.ts";
import { PluginProxy } from "../../../kompas/PluginProxy.ts";
import { PluginStore } from "../../../kompas/PluginStore.ts";
import { ThreadProfiles } from "../../../kompas/ThreadProfiles.ts";
import { WidgetPublisher } from "../../../kompas/WidgetDocument.ts";
import { WorkstreamStore } from "../../../kompas/WorkstreamStore.ts";
import { KompasSettingsStore } from "../../../kompas/KompasSettingsStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../../../orchestration-v2/ThreadSearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const caller = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
] as const;

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const list = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMinLength(1), Schema.isMaxLength(max));

const Title = text(120);

const Widget = Schema.Struct({
  attachmentId: Schema.String,
  tool: Schema.String,
  resourceUri: Schema.String,
  prefersBorder: Schema.optional(Schema.Boolean),
  csp: Schema.optional(
    Schema.Struct({ resourceDomains: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});
const Shown = Schema.Struct({ widget: Widget, message: Schema.String });

/** Reads T3 data or draws in the caller's thread, so read-only sandboxes and plan mode may call it. */
const readonlyTool = <T extends Tool.Any>(tool: T, title: string) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const widgetTool = <const Name extends string, Fields extends Schema.Struct.Fields>(
  name: Name,
  title: string,
  description: string,
  parameters: Schema.Struct<Fields>,
) =>
  readonlyTool(
    Tool.make(name, {
      description,
      parameters,
      success: Shown,
      failure: OrchestratorMcpFailure,
      failureMode: "return",
      dependencies: [...caller, WidgetPublisher],
    }),
    title,
  );

const QuizTool = widgetTool(
  "quiz",
  "Show a quiz",
  "Show a quiz the user answers in the thread. One correct option per question; vary its position.",
  Schema.Struct({
    title: Title,
    questions: list(
      Schema.Struct({
        question: text(500),
        options: Schema.Array(text(300)).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
        answer: Schema.Int.annotate({ description: "Index of the correct option, from 0." }),
        hint: Schema.optional(text(300)),
        explanation: Schema.optional(text(600)),
      }),
      30,
    ),
  }),
);

const ChartTool = widgetTool(
  "chart",
  "Show a chart",
  "Show numbers as a chart. Give labels and values, or points ([x, y]) for scatter.",
  Schema.Struct({
    title: Title,
    type: Schema.Literals(["line", "bar", "scatter", "pie"]),
    labels: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(500))),
    series: list(
      Schema.Struct({
        name: text(80),
        values: Schema.optional(
          Schema.Array(Schema.NullOr(Schema.Finite)).check(Schema.isMaxLength(500)),
        ),
        points: Schema.optional(
          Schema.Array(Schema.Array(Schema.Finite)).check(Schema.isMaxLength(2000)),
        ),
      }),
      12,
    ),
    xLabel: Schema.optional(text(80)),
    yLabel: Schema.optional(text(80)),
  }),
);

const DiagramTool = widgetTool(
  "diagram",
  "Show a diagram",
  "Show a process, relations or a mind map from Mermaid source. Quote labels with punctuation.",
  Schema.Struct({ title: Title, mermaid: text(20_000) }),
);

const LatLon = Schema.Array(Schema.Finite).annotate({ description: "[latitude, longitude]" });
const MapTool = widgetTool(
  "map",
  "Show a map",
  "Show places, routes or areas on a map. Give coordinates you are sure of.",
  Schema.Struct({
    title: Title,
    pins: Schema.optional(
      Schema.Array(
        Schema.Struct({
          lat: Schema.Finite,
          lon: Schema.Finite,
          label: text(120),
          description: Schema.optional(text(600)),
        }),
      ).check(Schema.isMaxLength(200)),
    ),
    routes: Schema.optional(
      Schema.Array(
        Schema.Struct({ label: Schema.optional(text(120)), points: Schema.Array(LatLon) }),
      ).check(Schema.isMaxLength(30)),
    ),
    areas: Schema.optional(
      Schema.Array(
        Schema.Struct({ label: Schema.optional(text(120)), points: Schema.Array(LatLon) }),
      ).check(Schema.isMaxLength(30)),
    ),
  }),
);

const MathTool = widgetTool(
  "math",
  "Show formulas and function plots",
  "Plot functions of x (like sin(x)/x, x^2, sqrt(abs(x))) and show LaTeX formulas with them.",
  Schema.Struct({
    title: Title,
    formulas: Schema.optional(Schema.Array(text(1000)).check(Schema.isMaxLength(20))),
    functions: Schema.optional(
      Schema.Array(
        Schema.Struct({ expression: text(200), label: Schema.optional(text(80)) }),
      ).check(Schema.isMaxLength(8)),
    ),
    xMin: Schema.optional(Schema.Finite),
    xMax: Schema.optional(Schema.Finite),
    yMin: Schema.optional(Schema.Finite),
    yMax: Schema.optional(Schema.Finite),
  }),
);

const TimelineTool = widgetTool(
  "timeline",
  "Show a timeline",
  "Show dated events in order, such as history or a study plan.",
  Schema.Struct({
    title: Title,
    events: list(
      Schema.Struct({
        date: text(60),
        title: text(160),
        description: Schema.optional(text(600)),
      }),
      100,
    ),
  }),
);

const TableTool = widgetTool(
  "table",
  "Show a table",
  "Show a table the user can sort and filter. Use it for comparisons with more than a few rows.",
  Schema.Struct({
    title: Title,
    columns: list(text(80), 12),
    rows: list(Schema.Array(Schema.String.check(Schema.isMaxLength(600))), 500),
  }),
);

const ChoicesTool = widgetTool(
  "choices",
  "Offer choices",
  "Ask a question with buttons. The pick arrives as the user's next message, so end your turn.",
  Schema.Struct({ question: text(300), options: list(text(120), 8) }),
);

const CardInput = Schema.Struct({
  front: text(1000),
  back: text(2000),
  hint: Schema.optional(text(300)),
  tags: Schema.optional(Schema.Array(text(40)).check(Schema.isMaxLength(8))),
});

const ShownDeck = Schema.Struct({
  deckId: Schema.String,
  cardCount: Schema.Number,
  ...Shown.fields,
});

const CreateDeckTool = readonlyTool(
  Tool.make("flashcards_create_deck", {
    description:
      "Save a deck of flashcards for spaced repetition and show it. One question per card, short answers.",
    parameters: Schema.Struct({ title: Title, cards: list(CardInput, 200) }),
    success: ShownDeck,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WidgetPublisher, LearningService],
  }),
  "Create flashcards",
);

const AddCardsTool = readonlyTool(
  Tool.make("flashcards_add", {
    description: "Add cards to an existing deck and show it.",
    parameters: Schema.Struct({ deckId: Schema.String, cards: list(CardInput, 200) }),
    success: ShownDeck,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WidgetPublisher, LearningService],
  }),
  "Add flashcards",
);

const ListDecksTool = readonlyTool(
  Tool.make("flashcards_list_decks", {
    description: "The user's decks with how many cards are due.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      decks: Schema.Array(
        Schema.Struct({
          deckId: Schema.String,
          title: Schema.String,
          cardCount: Schema.Number,
          dueCount: Schema.Number,
        }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, LearningService],
  }),
  "List decks",
);

const DueCardsTool = readonlyTool(
  Tool.make("flashcards_due", {
    description: "Cards due for review now, with answers, to quiz the user from.",
    parameters: Schema.Struct({ deckId: Schema.optional(Schema.String) }),
    success: Schema.Struct({
      total: Schema.Number,
      cards: Schema.Array(
        Schema.Struct({
          cardId: Schema.String,
          deck: Schema.String,
          front: Schema.String,
          back: Schema.String,
        }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, LearningService],
  }),
  "Cards due",
);

const StudyStatsTool = readonlyTool(
  Tool.make("study_stats", {
    description:
      "The user's study streak, review counts and weakest cards, to advise what to repeat.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      streakDays: Schema.Number,
      reviewsToday: Schema.Number,
      reviewsTotal: Schema.Number,
      dueCount: Schema.Number,
      weakest: Schema.Array(
        Schema.Struct({ deck: Schema.String, front: Schema.String, lapses: Schema.Number }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, LearningService],
  }),
  "Study stats",
);

const MemoryTool = readonlyTool(
  Tool.make("memory", {
    description:
      "Remember, change or forget a lasting fact about the user. add needs text; patch needs id and the whole new text; remove needs id. Ids are in the memory block.",
    parameters: Schema.Struct({
      action: Schema.Literals(["add", "patch", "remove"]),
      target: Schema.Literals(["user", "notes", "project"]),
      id: Schema.optional(Schema.String),
      text: Schema.optional(text(600)),
    }),
    success: Schema.Struct({
      status: Schema.Literals(["saved", "proposed", "removed"]),
      id: Schema.String,
      usage: Schema.String,
      widget: Schema.optional(Widget),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WidgetPublisher, MemoryService, ThreadProfiles],
  }),
  "Update memory",
);

const SessionSearchTool = readonlyTool(
  Tool.make("session_search", {
    description:
      "Search past conversations with any model. query finds conversations; threadId (with messageId) reads around a hit; neither lists recent ones.",
    parameters: Schema.Struct({
      query: Schema.optional(text(200)),
      threadId: Schema.optional(Schema.String),
      messageId: Schema.optional(Schema.String),
      around: Schema.optional(
        Schema.Int.annotate({ description: "Messages before and after, 1 to 20. Default 6." }),
      ),
    }),
    success: Schema.Struct({
      conversations: Schema.optional(
        Schema.Array(
          Schema.Struct({
            threadId: Schema.String,
            title: Schema.String,
            messageId: Schema.optional(Schema.String),
            snippet: Schema.optional(Schema.String),
            date: Schema.NullOr(Schema.String),
          }),
        ),
      ),
      messages: Schema.optional(
        Schema.Array(
          Schema.Struct({
            messageId: Schema.String,
            role: Schema.String,
            date: Schema.String,
            text: Schema.String,
          }),
        ),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, ThreadSearch, KompasSettingsStore],
  }),
  "Search past conversations",
);

const PluginToolsTool = readonlyTool(
  Tool.make("plugin_tools", {
    description: "Tools of the user's plugins in this conversation, with their input schemas.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          plugin: Schema.String,
          name: Schema.String,
          description: Schema.String,
          inputSchema: Schema.Unknown,
        }),
      ),
      unavailable: Schema.Array(Schema.String),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, PluginStore, PluginProxy],
  }),
  "List plugin tools",
);

const PluginCallTool = Tool.make("plugin_call", {
  description: "Call a tool from plugin_tools.",
  parameters: Schema.Struct({
    plugin: Schema.String,
    name: Schema.String,
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...caller, PluginStore, PluginProxy],
})
  .annotate(Tool.Title, "Call a plugin")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SuggestThreadsTool = readonlyTool(
  Tool.make("suggest_threads", {
    description: "Propose threads for the user to approve with one click. End your turn after it.",
    parameters: Schema.Struct({
      threads: list(Schema.Struct({ title: Title, task: text(4000) }), 8),
    }),
    success: Shown,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WidgetPublisher, WorkstreamStore],
  }),
  "Suggest threads",
);

const AskDecisionTool = readonlyTool(
  Tool.make("ask_decision", {
    description:
      "Ask the user to decide, with one button per option. The answer arrives as their next message, so end your turn.",
    parameters: Schema.Struct({ question: text(300), options: list(text(120), 6) }),
    success: Shown,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WidgetPublisher, WorkstreamStore],
  }),
  "Ask for a decision",
);

const LibraryItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["file", "deck", "note"]),
  title: Schema.String,
  content: Schema.String,
});

const LibraryListTool = readonlyTool(
  Tool.make("project_library_list", {
    description: "This project's library: files, decks and notes.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ items: Schema.Array(LibraryItem) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WorkstreamStore, ThreadProfiles],
  }),
  "List the project library",
);

const LibraryAddTool = readonlyTool(
  Tool.make("project_library_add", {
    description:
      "Add to this project's library: a file's absolute path, a deck's id, or a note's text.",
    parameters: Schema.Struct({
      kind: LibraryItem.fields.kind,
      title: Title,
      content: text(20_000),
    }),
    success: Schema.Struct({ id: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...caller, WorkstreamStore, ThreadProfiles],
  }),
  "Add to the project library",
);

export const KompasToolkit = Toolkit.make(
  QuizTool,
  ChartTool,
  DiagramTool,
  MapTool,
  MathTool,
  TimelineTool,
  TableTool,
  ChoicesTool,
  CreateDeckTool,
  AddCardsTool,
  ListDecksTool,
  DueCardsTool,
  StudyStatsTool,
  MemoryTool,
  SessionSearchTool,
  PluginToolsTool,
  PluginCallTool,
  SuggestThreadsTool,
  AskDecisionTool,
  LibraryListTool,
  LibraryAddTool,
);
