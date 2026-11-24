import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** Sent in place of a stored secret; saving it back keeps the stored value. */
export const PLUGIN_SECRET_REDACTED = "••••••••";

export const MEMORY_LIMITS = { user: 1375, notes: 2200, project: 2200 } as const;

// Settings

export const KompasSettings = Schema.Struct({
  developerMode: Schema.Boolean,
  memoryAskBeforeSaving: Schema.Boolean,
  memorySearchEnabled: Schema.Boolean,
});
export type KompasSettings = typeof KompasSettings.Type;

export const DEFAULT_KOMPAS_SETTINGS: KompasSettings = {
  developerMode: false,
  memoryAskBeforeSaving: false,
  memorySearchEnabled: true,
};

// Plugins

/** Becomes a tool prefix and a TOML key, and providers cap tool names at 64 characters. */
export const PluginName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(24),
  Schema.makeFilter((name: string) => !name.startsWith("t3-code") || "That name is reserved."),
);

const PluginSecrets = Schema.Record(Schema.String, Schema.String);

export const PluginTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/)),
    headers: PluginSecrets,
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: PluginSecrets,
  }),
]);
export type PluginTransport = typeof PluginTransport.Type;

export const PluginTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type PluginTool = typeof PluginTool.Type;

export const Plugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: PluginName,
  label: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  /** On in every conversation; otherwise only where a conversation turns it on. */
  allConversations: Schema.Boolean,
  transport: PluginTransport,
  disabledTools: Schema.Array(Schema.String),
});
export type Plugin = typeof Plugin.Type;

export const PluginState = Schema.Struct({
  ...Plugin.fields,
  /** The tools the last connection listed. */
  tools: Schema.Array(PluginTool),
  needsSignIn: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type PluginState = typeof PluginState.Type;

export const PluginThreadOverride = Schema.Struct({
  pluginId: Schema.String,
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export type PluginThreadOverride = typeof PluginThreadOverride.Type;

// Memory

export const MemoryEntry = Schema.Struct({
  id: Schema.String,
  /** `user`, `notes`, or `project:<workstream id>`. */
  scope: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["saved", "proposed"]),
  /** For a proposed change: the saved entry it replaces, or removes when the text is empty. */
  replacesId: Schema.NullOr(Schema.String),
  /** The model that wrote it; null when the user did. */
  model: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MemoryEntry = typeof MemoryEntry.Type;

// Learning

export const ReviewRating = Schema.Literals(["again", "hard", "good", "easy"]);
export type ReviewRating = typeof ReviewRating.Type;

export const Deck = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  cardCount: NonNegativeInt,
  dueCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type Deck = typeof Deck.Type;

export const Card = Schema.Struct({
  id: Schema.String,
  deckId: Schema.String,
  deckTitle: Schema.String,
  front: Schema.String,
  back: Schema.String,
  hint: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  due: IsoDateTime,
  reviewCount: NonNegativeInt,
  lapses: NonNegativeInt,
  /** When each rating would next show the card. */
  nextDue: Schema.Struct({
    again: IsoDateTime,
    hard: IsoDateTime,
    good: IsoDateTime,
    easy: IsoDateTime,
  }),
});
export type Card = typeof Card.Type;

export const StudyStats = Schema.Struct({
  streakDays: NonNegativeInt,
  reviewsToday: NonNegativeInt,
  reviewsTotal: NonNegativeInt,
  dueCount: NonNegativeInt,
  weakest: Schema.Array(
    Schema.Struct({
      cardId: Schema.String,
      deckTitle: Schema.String,
      front: Schema.String,
      lapses: NonNegativeInt,
    }),
  ),
});
export type StudyStats = typeof StudyStats.Type;

// Workstreams: "Projects" in the UI. A project in the code is a workspace folder.

export const WorkstreamThreadState = Schema.Literals([
  "needs_input",
  "working",
  "idle",
  "resolved",
  "failed",
]);
export type WorkstreamThreadState = typeof WorkstreamThreadState.Type;

export const WorkstreamThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  model: Schema.String,
  state: WorkstreamThreadState,
  lastLine: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type WorkstreamThread = typeof WorkstreamThread.Type;

export const WorkstreamLibraryItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["file", "deck", "note"]),
  title: Schema.String,
  /** A file's absolute path, a deck's id, or a note's text. */
  content: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type WorkstreamLibraryItem = typeof WorkstreamLibraryItem.Type;

export const WorkstreamSuggestion = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  task: Schema.String,
  createdAt: IsoDateTime,
});
export type WorkstreamSuggestion = typeof WorkstreamSuggestion.Type;

export const WorkstreamDecision = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
});
export type WorkstreamDecision = typeof WorkstreamDecision.Type;

export const Workstream = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  instructions: Schema.String,
  coordinatorThreadId: ThreadId,
  threadModel: Schema.NullOr(ModelSelection),
  maxParallelThreads: NonNegativeInt,
  askBeforeStart: Schema.Boolean,
  threads: Schema.Array(WorkstreamThread),
  library: Schema.Array(WorkstreamLibraryItem),
  suggestions: Schema.Array(WorkstreamSuggestion),
  decisions: Schema.Array(WorkstreamDecision),
  createdAt: IsoDateTime,
});
export type Workstream = typeof Workstream.Type;

/** Everything small enough to push whole; cards are read on demand. */
export const KompasSnapshot = Schema.Struct({
  settings: KompasSettings,
  /** The hidden project conversations live in; null where the server cannot provide one. */
  chatProjectId: Schema.NullOr(ProjectId),
  plugins: Schema.Array(PluginState),
  pluginThreads: Schema.Array(PluginThreadOverride),
  memory: Schema.Array(MemoryEntry),
  decks: Schema.Array(Deck),
  workstreams: Schema.Array(Workstream),
});
export type KompasSnapshot = typeof KompasSnapshot.Type;

export const KompasErrorReason = Schema.Literals([
  "not-found",
  "invalid",
  "limit",
  "needs-sign-in",
  "unreachable",
  "storage",
]);
export type KompasErrorReason = typeof KompasErrorReason.Type;

export class KompasError extends Schema.TaggedError<KompasError>()("KompasError", {
  reason: KompasErrorReason,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const KOMPAS_WS_METHODS = {
  subscribe: "kompas.subscribe",
  updateSettings: "kompas.updateSettings",
  savePlugin: "kompas.savePlugin",
  removePlugin: "kompas.removePlugin",
  testPlugin: "kompas.testPlugin",
  signInPlugin: "kompas.signInPlugin",
  setPluginForThread: "kompas.setPluginForThread",
  saveMemory: "kompas.saveMemory",
  removeMemory: "kompas.removeMemory",
  resolveMemory: "kompas.resolveMemory",
  listCards: "kompas.listCards",
  reviewCard: "kompas.reviewCard",
  saveCard: "kompas.saveCard",
  removeCard: "kompas.removeCard",
  saveDeck: "kompas.saveDeck",
  removeDeck: "kompas.removeDeck",
  exportDeck: "kompas.exportDeck",
  studyStats: "kompas.studyStats",
  createWorkstream: "kompas.createWorkstream",
  updateWorkstream: "kompas.updateWorkstream",
  removeWorkstream: "kompas.removeWorkstream",
  addLibraryItem: "kompas.addLibraryItem",
  removeLibraryItem: "kompas.removeLibraryItem",
  resolveSuggestion: "kompas.resolveSuggestion",
  answerDecision: "kompas.answerDecision",
  setThreadResolved: "kompas.setThreadResolved",
} as const;

const error = Schema.Union([KompasError, EnvironmentAuthorizationError]);
const ById = Schema.Struct({ id: Schema.String });

const KompasSubscribeRpc = Rpc.make(KOMPAS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: KompasSnapshot,
  error,
  stream: true,
});

const KompasUpdateSettingsRpc = Rpc.make(KOMPAS_WS_METHODS.updateSettings, {
  payload: Schema.Struct({
    developerMode: Schema.optionalKey(Schema.Boolean),
    memoryAskBeforeSaving: Schema.optionalKey(Schema.Boolean),
    memorySearchEnabled: Schema.optionalKey(Schema.Boolean),
  }),
  error,
});

const KompasSavePluginRpc = Rpc.make(KOMPAS_WS_METHODS.savePlugin, { payload: Plugin, error });
const KompasRemovePluginRpc = Rpc.make(KOMPAS_WS_METHODS.removePlugin, { payload: ById, error });
const KompasTestPluginRpc = Rpc.make(KOMPAS_WS_METHODS.testPlugin, {
  payload: ById,
  success: Schema.Struct({ tools: Schema.Array(PluginTool) }),
  error,
});
const KompasSignInPluginRpc = Rpc.make(KOMPAS_WS_METHODS.signInPlugin, {
  payload: Schema.Struct({
    id: Schema.String,
    /** The environment's HTTP origin as this browser reaches it; the provider redirects there. */
    redirectBaseUrl: TrimmedNonEmptyString,
  }),
  /** Null when the server needs no sign-in. */
  success: Schema.Struct({ authorizationUrl: Schema.NullOr(Schema.String) }),
  error,
});
const KompasSetPluginForThreadRpc = Rpc.make(KOMPAS_WS_METHODS.setPluginForThread, {
  payload: PluginThreadOverride,
  error,
});

const KompasSaveMemoryRpc = Rpc.make(KOMPAS_WS_METHODS.saveMemory, {
  payload: Schema.Struct({
    /** Absent for a new entry. */
    id: Schema.optionalKey(Schema.String),
    scope: Schema.String,
    text: TrimmedNonEmptyString,
  }),
  error,
});
const KompasRemoveMemoryRpc = Rpc.make(KOMPAS_WS_METHODS.removeMemory, { payload: ById, error });
const KompasResolveMemoryRpc = Rpc.make(KOMPAS_WS_METHODS.resolveMemory, {
  payload: Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
  error,
});

const KompasListCardsRpc = Rpc.make(KOMPAS_WS_METHODS.listCards, {
  payload: Schema.Struct({
    deckId: Schema.optionalKey(Schema.String),
    dueOnly: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  success: Schema.Struct({ cards: Schema.Array(Card) }),
  error,
});
const KompasReviewCardRpc = Rpc.make(KOMPAS_WS_METHODS.reviewCard, {
  payload: Schema.Struct({
    id: Schema.String,
    rating: ReviewRating,
    /** The card's `reviewCount` when it was rated, so a review made elsewhere is not undone. */
    reviewCount: Schema.optionalKey(Schema.Int),
  }),
  success: Card,
  error,
});
const KompasSaveCardRpc = Rpc.make(KOMPAS_WS_METHODS.saveCard, {
  payload: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    deckId: Schema.String,
    front: TrimmedNonEmptyString,
    back: TrimmedNonEmptyString,
    hint: Schema.NullOr(Schema.String),
  }),
  error,
});
const KompasRemoveCardRpc = Rpc.make(KOMPAS_WS_METHODS.removeCard, { payload: ById, error });
const KompasSaveDeckRpc = Rpc.make(KOMPAS_WS_METHODS.saveDeck, {
  payload: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    title: TrimmedNonEmptyString,
  }),
  success: ById,
  error,
});
const KompasRemoveDeckRpc = Rpc.make(KOMPAS_WS_METHODS.removeDeck, { payload: ById, error });
const KompasExportDeckRpc = Rpc.make(KOMPAS_WS_METHODS.exportDeck, {
  payload: ById,
  success: Schema.Struct({ fileName: Schema.String, csv: Schema.String }),
  error,
});
const KompasStudyStatsRpc = Rpc.make(KOMPAS_WS_METHODS.studyStats, {
  payload: Schema.Struct({}),
  success: StudyStats,
  error,
});

const WorkstreamFields = {
  title: TrimmedNonEmptyString,
  goal: Schema.String,
  instructions: Schema.String,
  threadModel: Schema.NullOr(ModelSelection),
  maxParallelThreads: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  askBeforeStart: Schema.Boolean,
};
const KompasCreateWorkstreamRpc = Rpc.make(KOMPAS_WS_METHODS.createWorkstream, {
  payload: Schema.Struct({ ...WorkstreamFields, coordinatorModel: ModelSelection }),
  success: Schema.Struct({ id: Schema.String, coordinatorThreadId: ThreadId }),
  error,
});
const KompasUpdateWorkstreamRpc = Rpc.make(KOMPAS_WS_METHODS.updateWorkstream, {
  payload: Schema.Struct({ id: Schema.String, ...WorkstreamFields }),
  error,
});
const KompasRemoveWorkstreamRpc = Rpc.make(KOMPAS_WS_METHODS.removeWorkstream, {
  payload: ById,
  error,
});
const KompasAddLibraryItemRpc = Rpc.make(KOMPAS_WS_METHODS.addLibraryItem, {
  payload: Schema.Struct({
    workstreamId: Schema.String,
    kind: WorkstreamLibraryItem.fields.kind,
    title: TrimmedNonEmptyString,
    content: TrimmedNonEmptyString,
  }),
  error,
});
const KompasRemoveLibraryItemRpc = Rpc.make(KOMPAS_WS_METHODS.removeLibraryItem, {
  payload: ById,
  error,
});
const KompasResolveSuggestionRpc = Rpc.make(KOMPAS_WS_METHODS.resolveSuggestion, {
  payload: Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
  error,
});
const KompasAnswerDecisionRpc = Rpc.make(KOMPAS_WS_METHODS.answerDecision, {
  payload: Schema.Struct({ id: Schema.String, answer: TrimmedNonEmptyString }),
  error,
});
const KompasSetThreadResolvedRpc = Rpc.make(KOMPAS_WS_METHODS.setThreadResolved, {
  payload: Schema.Struct({
    workstreamId: Schema.String,
    threadId: ThreadId,
    resolved: Schema.Boolean,
  }),
  error,
});

export const KOMPAS_RPCS = [
  KompasSubscribeRpc,
  KompasUpdateSettingsRpc,
  KompasSavePluginRpc,
  KompasRemovePluginRpc,
  KompasTestPluginRpc,
  KompasSignInPluginRpc,
  KompasSetPluginForThreadRpc,
  KompasSaveMemoryRpc,
  KompasRemoveMemoryRpc,
  KompasResolveMemoryRpc,
  KompasListCardsRpc,
  KompasReviewCardRpc,
  KompasSaveCardRpc,
  KompasRemoveCardRpc,
  KompasSaveDeckRpc,
  KompasRemoveDeckRpc,
  KompasExportDeckRpc,
  KompasStudyStatsRpc,
  KompasCreateWorkstreamRpc,
  KompasUpdateWorkstreamRpc,
  KompasRemoveWorkstreamRpc,
  KompasAddLibraryItemRpc,
  KompasRemoveLibraryItemRpc,
  KompasResolveSuggestionRpc,
  KompasAnswerDecisionRpc,
  KompasSetThreadResolvedRpc,
] as const;

/** Mutations a client checks before sending. */
export const KOMPAS_GUARDED_RPC_SCOPES = {
  [KOMPAS_WS_METHODS.updateSettings]: AuthSettingsWriteScope,
  // A stdio plugin is a command this machine runs, and a header is a stored credential.
  [KOMPAS_WS_METHODS.savePlugin]: AuthSettingsWriteScope,
  [KOMPAS_WS_METHODS.removePlugin]: AuthSettingsWriteScope,
  [KOMPAS_WS_METHODS.testPlugin]: AuthSettingsWriteScope,
  [KOMPAS_WS_METHODS.signInPlugin]: AuthSettingsWriteScope,
  [KOMPAS_WS_METHODS.setPluginForThread]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.saveMemory]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.removeMemory]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.resolveMemory]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.reviewCard]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.saveCard]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.removeCard]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.saveDeck]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.removeDeck]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.createWorkstream]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.updateWorkstream]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.removeWorkstream]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.addLibraryItem]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.removeLibraryItem]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.resolveSuggestion]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.answerDecision]: AuthOrchestrationOperateScope,
  [KOMPAS_WS_METHODS.setThreadResolved]: AuthOrchestrationOperateScope,
} as const;

export const KOMPAS_RPC_SCOPES = {
  [KOMPAS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [KOMPAS_WS_METHODS.listCards]: AuthOrchestrationReadScope,
  [KOMPAS_WS_METHODS.exportDeck]: AuthOrchestrationReadScope,
  [KOMPAS_WS_METHODS.studyStats]: AuthOrchestrationReadScope,
} as const;

export type KompasRpcMethod = (typeof KOMPAS_WS_METHODS)[keyof typeof KOMPAS_WS_METHODS];

/** Every method's metric label. */
export const KOMPAS_RPC_AGGREGATES = Object.fromEntries(
  Object.values(KOMPAS_WS_METHODS).map((method) => [method, "kompas"]),
) as Record<KompasRpcMethod, "kompas">;
