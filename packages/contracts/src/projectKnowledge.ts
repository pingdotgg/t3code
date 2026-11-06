import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

export const ProjectFactId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectFactId"));
export type ProjectFactId = typeof ProjectFactId.Type;
export const KnowledgeDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const KnowledgeMessageRef = Schema.Struct({
  kind: Schema.Literal("message"),
  threadId: ThreadId,
  messageId: MessageId,
  digest: KnowledgeDigest,
});
export type KnowledgeMessageRef = typeof KnowledgeMessageRef.Type;
export const KnowledgeFactSource = Schema.Union([
  KnowledgeMessageRef,
  Schema.Struct({ kind: Schema.Literal("user") }),
]);
export type KnowledgeFactSource = typeof KnowledgeFactSource.Type;
const knownKnowledgeOrigins = [
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent-thread"),
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent-client"),
    sessionId: TrimmedNonEmptyString,
    label: Schema.String,
  }),
  // Written only by the server's automatic learning job, never accepted from a client or agent.
  Schema.Struct({
    kind: Schema.Literal("assisted"),
    threadId: ThreadId,
    runId: RunId,
    runOutcome: Schema.Literals(["completed", "failed", "interrupted"]),
  }),
] as const;
const knownKnowledgeOriginKinds: ReadonlySet<string> = new Set(
  knownKnowledgeOrigins.map((member) => member.fields.kind.literal),
);
// Older clients read facts written by newer servers. An origin kind they do not know decodes to
// this variant instead of failing the whole list, and encodes back to its original kind.
const UnknownKnowledgeOrigin = Schema.Struct({
  kind: Schema.String.check(
    Schema.makeFilter(
      (kind: string) =>
        !knownKnowledgeOriginKinds.has(kind) || "A known origin must decode in full.",
    ),
  ),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ kind: Schema.Literal("unknown"), originKind: Schema.String }),
    SchemaTransformation.transform({
      decode: ({ kind }: { readonly kind: string }) => ({
        kind: "unknown" as const,
        originKind: kind,
      }),
      encode: ({ originKind }) => ({ kind: originKind }),
    }),
  ),
);
export const KnowledgeOrigin = Schema.Union([...knownKnowledgeOrigins, UnknownKnowledgeOrigin]);
export type KnowledgeOrigin = typeof KnowledgeOrigin.Type;
export const KnowledgeSelection = Schema.Union([
  KnowledgeMessageRef,
  Schema.Struct({ kind: Schema.Literal("fact"), factId: ProjectFactId, revision: PositiveInt }),
]);
export type KnowledgeSelection = typeof KnowledgeSelection.Type;
export const ProjectFactKind = Schema.Literals(["decision", "constraint", "convention", "note"]);
const Labels = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(32),
);
export const ProjectFactFields = Schema.Struct({
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  entities: Labels,
  tags: Labels,
  kind: ProjectFactKind,
  sources: Schema.Array(KnowledgeFactSource).check(Schema.isMaxLength(16)),
});
export const ProjectFactStatus = Schema.Literals(["saved", "forgotten"]);
export type ProjectFactStatus = typeof ProjectFactStatus.Type;
const FactIdentity = {
  id: ProjectFactId,
  origin: KnowledgeOrigin,
  projectId: ProjectId,
  kind: ProjectFactKind,
  revision: PositiveInt,
  trust: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  retrievalCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // A superseded fact keeps its status and content but drops out of recall by default.
  // Optional so facts from older servers still decode.
  supersedes: Schema.optionalKey(Schema.NullOr(ProjectFactId)),
  supersededBy: Schema.optionalKey(Schema.NullOr(ProjectFactId)),
};
export const ActiveProjectFact = Schema.Struct({
  ...FactIdentity,
  ...ProjectFactFields.fields,
  status: Schema.Literal("saved"),
  forgottenAt: Schema.Null,
});
const ForgottenProjectFact = Schema.Struct({
  ...FactIdentity,
  status: Schema.Literal("forgotten"),
  content: Schema.Null,
  entities: Schema.Array(Schema.Never),
  tags: Schema.Array(Schema.Never),
  sources: Schema.Array(Schema.Never),
  forgottenAt: IsoDateTime,
});
const ProjectFactSchema = Schema.Union([ActiveProjectFact, ForgottenProjectFact]);
export type ProjectFact = typeof ProjectFactSchema.Type;
export const ProjectFact: Schema.Codec<ProjectFact, typeof ProjectFactSchema.Encoded> =
  ProjectFactSchema;
const MutationIdentity = { commandId: CommandId, projectId: ProjectId, factId: ProjectFactId };
const ExistingFact = { ...MutationIdentity, expectedRevision: PositiveInt };
const ProjectKnowledgeMutationSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    ...MutationIdentity,
    ...ProjectFactFields.fields,
  }),
  Schema.Struct({ action: Schema.Literal("edit"), ...ExistingFact, ...ProjectFactFields.fields }),
  Schema.Struct({ action: Schema.Literal("forget"), ...ExistingFact }),
  Schema.Struct({ action: Schema.Literal("feedback"), ...ExistingFact, helpful: Schema.Boolean }),
  // Creates replacementFactId and links it to factId, which keeps its content (unlike forget).
  Schema.Struct({
    action: Schema.Literal("supersede"),
    ...ExistingFact,
    replacementFactId: ProjectFactId,
    ...ProjectFactFields.fields,
  }),
]);
export type ProjectKnowledgeMutation = typeof ProjectKnowledgeMutationSchema.Type;
export const ProjectKnowledgeMutation: Schema.Codec<
  ProjectKnowledgeMutation,
  typeof ProjectKnowledgeMutationSchema.Encoded
> = ProjectKnowledgeMutationSchema;
/** Lexical, not semantic: a cue for the user to compare, never an automatic decision. */
export const KnowledgeConflictHint = Schema.Struct({
  kind: Schema.Literals(["duplicate", "near_duplicate", "possible_conflict"]),
  factId: ProjectFactId,
  revision: PositiveInt,
  excerpt: Schema.String.check(Schema.isMaxLength(320)),
  similarity: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type KnowledgeConflictHint = typeof KnowledgeConflictHint.Type;
const ConflictHints = Schema.Array(KnowledgeConflictHint).check(Schema.isMaxLength(3));
// Extra keys are ignored by older clients, which decode this as a plain ProjectFact.
const ProjectKnowledgeMutationResultSchema = Schema.Union([
  Schema.Struct({ ...ActiveProjectFact.fields, hints: Schema.optionalKey(ConflictHints) }),
  Schema.Struct({ ...ForgottenProjectFact.fields, hints: Schema.optionalKey(ConflictHints) }),
]);
export type ProjectKnowledgeMutationResult = typeof ProjectKnowledgeMutationResultSchema.Type;
export const ProjectKnowledgeMutationResult: Schema.Codec<
  ProjectKnowledgeMutationResult,
  typeof ProjectKnowledgeMutationResultSchema.Encoded
> = ProjectKnowledgeMutationResultSchema;
export const ProjectKnowledgeListInput = Schema.Struct({
  projectId: ProjectId,
  status: Schema.optionalKey(ProjectFactStatus),
  afterId: Schema.optionalKey(ProjectFactId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  includeSuperseded: Schema.optionalKey(Schema.Boolean),
  /** Only facts whose message citations no longer resolve. */
  sourceState: Schema.optionalKey(Schema.Literal("unavailable")),
  /** Only facts saved by automatic learning. */
  origin: Schema.optionalKey(Schema.Literal("assisted")),
});
export type ProjectKnowledgeListInput = typeof ProjectKnowledgeListInput.Type;
export const KnowledgeSourceUnavailableReason = Schema.Literals([
  "missing",
  "deleted",
  "archived",
  "wrong_project",
  "streaming",
  "changed",
]);
export type KnowledgeSourceUnavailableReason = typeof KnowledgeSourceUnavailableReason.Type;
const ProjectKnowledgeListResultSchema = Schema.Struct({
  facts: Schema.Array(ProjectFact),
  nextCursor: Schema.NullOr(ProjectFactId),
  // Facts on this page whose message citations no longer resolve, read as if
  // archived conversations are excluded. Optional so older servers still decode.
  unavailableSources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ factId: ProjectFactId, reason: KnowledgeSourceUnavailableReason }),
    ),
  ),
});
export type ProjectKnowledgeListResult = typeof ProjectKnowledgeListResultSchema.Type;
export const ProjectKnowledgeListResult: Schema.Codec<
  ProjectKnowledgeListResult,
  typeof ProjectKnowledgeListResultSchema.Encoded
> = ProjectKnowledgeListResultSchema;
export const ProjectKnowledgeReadFactInput = Schema.Struct({
  projectId: ProjectId,
  factId: ProjectFactId,
});
export type ProjectKnowledgeReadFactInput = typeof ProjectKnowledgeReadFactInput.Type;
export const ProjectFactHistoryEvent = Schema.Literals([
  // History starts here for facts saved before history was recorded.
  "baseline",
  "created",
  "edited",
  // Past reviews only; nothing records this any more.
  "confirmed",
  "forgotten",
  "feedback",
  "superseded",
]);
export type ProjectFactHistoryEvent = typeof ProjectFactHistoryEvent.Type;
export const ProjectFactHistoryEntry = Schema.Struct({
  sequence: PositiveInt,
  event: ProjectFactHistoryEvent,
  revision: PositiveInt,
  actor: KnowledgeOrigin,
  at: IsoDateTime,
  contentDigest: Schema.NullOr(KnowledgeDigest),
  // Erased with the fact when it is forgotten.
  content: Schema.NullOr(Schema.String),
  sources: Schema.Array(KnowledgeFactSource),
  trustBefore: Schema.NullOr(Schema.Number),
  trustAfter: Schema.Number,
  helpful: Schema.NullOr(Schema.Boolean),
  // The replacement for "superseded"; the replaced fact for a superseding "created".
  relatedFactId: Schema.NullOr(ProjectFactId),
  sourceUnavailable: Schema.NullOr(KnowledgeSourceUnavailableReason),
});
export type ProjectFactHistoryEntry = typeof ProjectFactHistoryEntry.Type;
export const ProjectFactSummary = Schema.Struct({
  id: ProjectFactId,
  status: ProjectFactStatus,
  revision: PositiveInt,
  excerpt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(320))),
});
export type ProjectFactSummary = typeof ProjectFactSummary.Type;
const ProjectKnowledgeFactDetailSchema = Schema.Struct({
  fact: ProjectFact,
  sourceUnavailable: Schema.NullOr(KnowledgeSourceUnavailableReason),
  // Oldest first; the most recent 50 events.
  history: Schema.Array(ProjectFactHistoryEntry).check(Schema.isMaxLength(50)),
  historyTruncated: Schema.Boolean,
  supersedes: Schema.NullOr(ProjectFactSummary),
  supersededBy: Schema.NullOr(ProjectFactSummary),
  hints: ConflictHints,
});
export type ProjectKnowledgeFactDetail = typeof ProjectKnowledgeFactDetailSchema.Type;
export const ProjectKnowledgeFactDetail: Schema.Codec<
  ProjectKnowledgeFactDetail,
  typeof ProjectKnowledgeFactDetailSchema.Encoded
> = ProjectKnowledgeFactDetailSchema;
export const ProjectKnowledgeStatusInput = Schema.Struct({ projectId: ProjectId });
export type ProjectKnowledgeStatusInput = typeof ProjectKnowledgeStatusInput.Type;
export const AssistedLearningRunOutcome = Schema.Literals(["completed", "failed", "interrupted"]);
export type AssistedLearningRunOutcome = typeof AssistedLearningRunOutcome.Type;
export const AssistedLearningRun = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  runOutcome: AssistedLearningRunOutcome,
  result: Schema.Literals(["ran", "skipped", "failed"]),
  reason: Schema.NullOr(Schema.String),
  saved: NonNegativeInt,
  at: IsoDateTime,
});
export type AssistedLearningRun = typeof AssistedLearningRun.Type;
export const ProjectKnowledgeStatus = Schema.Struct({
  // saved excludes superseded facts, which are counted on their own.
  counts: Schema.Struct({
    saved: NonNegativeInt,
    superseded: NonNegativeInt,
    forgotten: NonNegativeInt,
  }),
  // Recallable facts (saved, not superseded) by trust quartile.
  trustBands: Schema.Struct({
    low: NonNegativeInt,
    guarded: NonNegativeInt,
    steady: NonNegativeInt,
    high: NonNegativeInt,
  }),
  recallThreshold: Schema.Number,
  belowRecallThreshold: NonNegativeInt,
  retrievals: NonNegativeInt,
  feedback: Schema.Struct({ helpful: NonNegativeInt, unhelpful: NonNegativeInt }),
  unavailableSources: NonNegativeInt,
  unavailableSourcesCoverage: Schema.Literals(["complete", "partial"]),
  // Optional so older servers still decode.
  assistedLearning: Schema.optionalKey(
    Schema.Struct({ lastRun: Schema.NullOr(AssistedLearningRun) }),
  ),
});
export type ProjectKnowledgeStatus = typeof ProjectKnowledgeStatus.Type;
export const ProjectKnowledgeReadSourceInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
  digest: Schema.optionalKey(KnowledgeDigest),
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type ProjectKnowledgeReadSourceInput = typeof ProjectKnowledgeReadSourceInput.Type;
const ProjectKnowledgeSourceSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: KnowledgeMessageRef,
    text: Schema.String,
    title: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    createdAt: IsoDateTime,
    archived: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: KnowledgeSourceUnavailableReason,
  }),
]);
export type ProjectKnowledgeSource = typeof ProjectKnowledgeSourceSchema.Type;
export const ProjectKnowledgeSource: Schema.Codec<
  ProjectKnowledgeSource,
  typeof ProjectKnowledgeSourceSchema.Encoded
> = ProjectKnowledgeSourceSchema;
const ProjectKnowledgeContextSchema = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  selections: Schema.Array(KnowledgeSelection).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48000 })),
});
export type ProjectKnowledgeContext = typeof ProjectKnowledgeContextSchema.Type;
export const ProjectKnowledgeContext = ProjectKnowledgeContextSchema;
const ProjectKnowledgePreparedContextSchema = Schema.Struct({
  context: ProjectKnowledgeContext,
  text: Schema.String,
  byteLength: NonNegativeInt,
  // Older remote servers return only the exact payload.
  items: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  ),
});
export type ProjectKnowledgePreparedContext = typeof ProjectKnowledgePreparedContextSchema.Type;
export const ProjectKnowledgePreparedContext: Schema.Codec<
  ProjectKnowledgePreparedContext,
  typeof ProjectKnowledgePreparedContextSchema.Encoded
> = ProjectKnowledgePreparedContextSchema;
export const ProjectKnowledgeDeliveryStatus = Schema.Literals([
  "prepared",
  "sent",
  "failed",
  "uncertain",
]);
export type ProjectKnowledgeDeliveryStatus = typeof ProjectKnowledgeDeliveryStatus.Type;
export const ProjectKnowledgeDeliveryItem = Schema.Struct({
  contextId: TrimmedNonEmptyString,
  label: Schema.String,
  context: ProjectKnowledgeContext,
  text: Schema.String,
  // Set, with text emptied, once a fact this item selected is forgotten. The text renders all of
  // the item's selections together, so the whole excerpt goes rather than a guessed slice.
  contentRemoved: Schema.optionalKey(Schema.Boolean),
});
export type ProjectKnowledgeDeliveryItem = typeof ProjectKnowledgeDeliveryItem.Type;
export const ProjectKnowledgeDeliveryOmission = Schema.Struct({
  contextId: TrimmedNonEmptyString,
  label: Schema.String,
  reason: Schema.Literals([
    "over_budget",
    "source_unavailable",
    "stale_revision",
    "not_permitted",
    "recall_failed",
    "not_referenced",
  ]),
});
export const ProjectKnowledgeDeliveryBudget = Schema.Struct({
  // Conservative payload occupancy survives source scrubbing and process restarts.
  estimatedTokens: Schema.optionalKey(NonNegativeInt),
  capacity: Schema.Number,
  occupancy: Schema.Number,
  requestSize: Schema.Number,
  headroom: Schema.Number,
  knowledgeAllowance: Schema.Number,
  tokenCap: Schema.Number,
  byteCap: Schema.Number,
});
export const ProjectKnowledgeDelivery = Schema.Struct({
  budget: Schema.optionalKey(ProjectKnowledgeDeliveryBudget),
  attemptId: RunAttemptId,
  runId: RunId,
  threadId: ThreadId,
  messageId: MessageId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.optionalKey(ProviderThreadId),
  nativeThreadId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  status: ProjectKnowledgeDeliveryStatus,
  items: Schema.Array(ProjectKnowledgeDeliveryItem),
  omissions: Schema.Array(ProjectKnowledgeDeliveryOmission),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectKnowledgeDelivery = typeof ProjectKnowledgeDelivery.Type;
export const ProjectKnowledgeReadDeliveriesInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
});
export type ProjectKnowledgeReadDeliveriesInput = typeof ProjectKnowledgeReadDeliveriesInput.Type;
export const ProjectKnowledgeDeliveredSelectionState = Schema.Literals([
  "current",
  "changed",
  "forgotten",
  "unavailable",
]);
export const ProjectKnowledgeDeliveries = Schema.Struct({
  // Oldest first; a replacement attempt (account failover) appends its own record.
  deliveries: Schema.Array(
    Schema.Struct({
      ...ProjectKnowledgeDelivery.fields,
      items: Schema.Array(
        Schema.Struct({
          ...ProjectKnowledgeDeliveryItem.fields,
          current: ProjectKnowledgeDeliveredSelectionState,
        }),
      ),
    }),
  ),
});
export type ProjectKnowledgeDeliveries = typeof ProjectKnowledgeDeliveries.Type;
export const KnowledgeSearchCursor = Schema.Struct({
  requestId: CommandId,
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(1000)),
});
export const ProjectKnowledgeSearchInput = Schema.Struct({
  ...OrchestrationSearchThreadsInput.fields,
  projectId: ProjectId,
  requestId: CommandId,
  minTrust: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /** Browsing facts can keep the unused conversation results smaller than the fact page. */
  messageLimit: OrchestrationSearchThreadsInput.fields.limit,
  factCursor: Schema.optionalKey(KnowledgeSearchCursor),
  entities: Schema.optionalKey(Labels),
  entityMatch: Schema.optionalKey(Schema.Literals(["any", "all"])),
  includeSuperseded: Schema.optionalKey(Schema.Boolean),
  // Retrieval reinforces ranking. Browsing surfaces (as-you-type, previews) pass false so only
  // deliberate lookups count; omitted means true.
  recordRetrieval: Schema.optionalKey(Schema.Boolean),
});
export type ProjectKnowledgeSearchInput = typeof ProjectKnowledgeSearchInput.Type;
export const KnowledgeScore = Schema.Struct({
  holographic: Schema.Number,
  lexical: Schema.Number,
  tokenOverlap: Schema.Number,
  temporalDecay: Schema.Number,
  reinforcement: Schema.Number,
  trust: Schema.Number,
  combined: Schema.Number,
});
const ProjectKnowledgeSearchResultSchema = Schema.Struct({
  messages: OrchestrationSearchThreadsResult,
  facts: Schema.Union([
    Schema.Struct({
      state: Schema.Literal("available"),
      matches: Schema.Array(Schema.Struct({ fact: ProjectFact, score: KnowledgeScore })),
      coverage: Schema.Literals(["complete", "partial"]),
      nextCursor: Schema.NullOr(KnowledgeSearchCursor),
    }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      reason: Schema.Literal("kernel_unavailable"),
    }),
  ]),
});
export type ProjectKnowledgeSearchResult = typeof ProjectKnowledgeSearchResultSchema.Type;
export const ProjectKnowledgeSearchResult: Schema.Codec<
  ProjectKnowledgeSearchResult,
  typeof ProjectKnowledgeSearchResultSchema.Encoded
> = ProjectKnowledgeSearchResultSchema;
export class ProjectKnowledgeError extends Schema.TaggedError<ProjectKnowledgeError>()(
  "ProjectKnowledgeError",
  {
    reason: Schema.Literals([
      "missing_project",
      "missing_fact",
      "conflict",
      "forgotten",
      "invalid_source",
      "fact_size",
      "wrong_environment",
      "wrong_project",
      "stale_context",
      "context_budget",
      "command_reused",
      "storage",
      "invalid_cursor",
      "scoring",
      "superseded",
    ]),
    projectId: ProjectId,
    factId: Schema.optionalKey(ProjectFactId),
    currentRevision: Schema.optionalKey(PositiveInt),
    byteLength: Schema.optionalKey(NonNegativeInt),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "conflict":
        return "This fact changed. Refresh it before editing.";
      case "forgotten":
        return "This fact was forgotten and cannot be restored.";
      case "fact_size":
        return "Fact text and entities must fit within 16 KiB, and each tag within 256 UTF-8 bytes.";
      case "invalid_source":
        return "The selected source is unavailable or has changed.";
      case "wrong_project":
        return "This context belongs to another project.";
      case "wrong_environment":
        return "This context belongs to another environment.";
      case "stale_context":
        return "Selected knowledge changed. Refresh or remove it before sending.";
      case "context_budget":
        return "Selected knowledge exceeds the context allowance. Remove an item before sending.";
      case "command_reused":
        return "This request ID already belongs to another operation.";
      case "missing_fact":
        return "The project fact was not found.";
      case "missing_project":
        return "The project was not found.";
      case "invalid_cursor":
        return "This search continuation belongs to another query. Search again.";
      case "scoring":
        return "Project knowledge scoring failed. Try a smaller query or try again.";
      case "storage":
        return "Project knowledge storage is unavailable.";
      case "superseded":
        return "This fact was superseded. Edit or supersede its replacement instead.";
    }
  }
}
