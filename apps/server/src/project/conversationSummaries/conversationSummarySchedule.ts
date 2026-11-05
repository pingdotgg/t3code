import {
  CommandId,
  type ConversationSummaryId,
  type OrchestrationV2ContextHandoff,
  type ProjectId,
  type RunId,
  type ServerSettings,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PendingOrchestrationEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";

/**
 * The summary pass after one completed run, or nothing when the project has not opted in. The
 * effect id is derived from the run, so a replayed finalization coalesces into the queued pass.
 */
export function conversationSummaryEffects(input: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  if (!resolveProjectSettings(input.settings, input.projectId).settings.enableConversationSummaries)
    return [];
  return [conversationSummaryEffect(input)];
}

export function conversationSummaryEffect(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly pass?: number;
}): PendingOrchestrationEffectV2 {
  const pass = input.pass ?? 0;
  const id = `effect:conversation-summary.generate:${input.runId}${pass === 0 ? "" : `:pass:${pass}`}`;
  return {
    id,
    commandId: CommandId.make(`command:${id}`),
    threadId: input.threadId,
    request: {
      type: "conversation-summary.generate",
      runId: input.runId,
      ...(pass === 0 ? {} : { pass }),
    },
  };
}

/** A failed pass retains its durable work item for the effect worker's bounded retries. */
export class ConversationSummaryPassError extends Schema.TaggedError<ConversationSummaryPassError>()(
  "ConversationSummaryPassError",
  { runId: Schema.String, cause: Schema.Defect() },
) {}

/** A current summary that may stand in for the handoff items it covers. */
export interface HandoffSummary {
  readonly id: ConversationSummaryId;
  readonly summaryIds?: ReadonlyArray<ConversationSummaryId>;
  /** Labelled as a generated summary, with the ids needed to expand its sources. */
  readonly text: string;
  readonly coveredItemIds: ReadonlyArray<TurnItemId>;
}

export interface ConversationSummaryRuntimeShape {
  readonly summarizeThread: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<{ readonly hasMore: boolean }, ConversationSummaryPassError>;
  /**
   * Current summaries, oldest first, whose sources are all among `itemIds` of the pending
   * handoffs. Never fails: a summary that cannot be verified is simply not offered.
   */
  readonly forHandoff: (input: {
    readonly projectId: ProjectId;
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly itemIds: ReadonlySet<string>;
  }) => Effect.Effect<ReadonlyArray<HandoffSummary>>;
}

/**
 * A reference with a no-op default so orchestration layers built without conversation summaries
 * (tests, the CLI) still run; the server provides the real one.
 */
export class ConversationSummaryRuntime extends Context.Reference<ConversationSummaryRuntimeShape>(
  "t3/project/conversationSummaries/ConversationSummaryRuntime",
  {
    defaultValue: () => ({
      summarizeThread: () => Effect.succeed({ hasMore: false }),
      forHandoff: () => Effect.succeed([]),
    }),
  },
) {}
