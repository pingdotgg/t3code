/**
 * Wire and bookkeeping types shared by the OpenCode 2 session helpers.
 */
import {
  Model,
  Permission,
  type OpenCodeEvent,
} from "@opencode/client/effect";
import type { OrchestrationV2AppThread, OrchestrationV2ExecutionNode, OrchestrationV2ProviderFailure, OrchestrationV2ProviderRetry, OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2RuntimeRequest, OrchestrationV2Subagent, OrchestrationV2TurnItem, MessageId, ModelSelection, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as OpenCode2Client from "../OpenCode2Client.ts";
import { type BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;
export type Tokens = EventOf<"session.step.ended">["data"]["tokens"];

export interface TurnOwner {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly runId: RunId | null;
  readonly runOrdinal: number;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "cwd">;
}

export interface ActiveTurn {
  readonly input: TurnOwner;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  readonly usage: {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  // Steps OpenCode started; a step that ends without tokens leaves the total partial.
  startedSteps: number;
  // A reconnect dropped events, so steps may have ended unseen.
  missedEvents: boolean;
  steps: number;
  readonly models: Set<string>;
  lastStep: Tokens | undefined;
  before: string | null | undefined;
  compaction: { readonly nativeId: string; readonly startedAt: DateTime.Utc } | undefined;
  compactions: number;
  retry:
    | {
        readonly retry: OrchestrationV2ProviderRetry;
        readonly failure: OrchestrationV2ProviderFailure;
        readonly startedAt: DateTime.Utc;
      }
    | undefined;
  interrupted: boolean;
  unsent: boolean;
  readonly steers: Set<string>;
  readonly settledInbox: Set<string>;
  heldEnd: TurnTerminal | undefined;
  awaitingStart: boolean;
  /** Scope child tool IDs because model-generated IDs can repeat parent IDs. */
  readonly scope: string;
  usedSubagents: boolean;
}

export interface SubagentCall {
  readonly toolId: string;
  readonly nativeId: string;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  prompt: string;
  title: string | null;
  agent: string | undefined;
  model: string | null;
  background: boolean;
  joined: SubagentCall | undefined;
  child: ThreadState | undefined;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  completedAt: DateTime.Utc | null;
}

export interface Wake {
  readonly messageId: MessageId | undefined;
  readonly events: Array<OpenCode2Client.OpenCode2StreamEvent>;
  running: boolean;
  readonly reports: Array<BackgroundWorkReport>;
  readonly detail: string | null;
  dropped: boolean;
  readonly after: string | undefined;
  readonly first: string | undefined;
  readonly children: Set<string>;
}

export interface OpenBlock {
  readonly block: { readonly assistantMessageID: string; readonly ordinal: number };
  readonly kind: "text" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
}

export interface ThreadState {
  readonly sessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  publishedBackgroundWork?: boolean;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  active: ActiveTurn | undefined;
  model: ModelRef | undefined;
  /** Locally ended but possibly live; consume its next execution end without settling a new turn. */
  unsettled: boolean;
  /** A late first start belongs to the failed prompt; only a subsequent start proves a lost end. */
  unsettledStarted: boolean;
  directory: string;
  agent: string;
  title: string | undefined;
  rules: ReadonlyArray<Rule> | undefined;
  policy: RulesPolicy;
  readonly grants: Array<Rule>;
  readonly calls: Map<string, SubagentCall>;
  subagent:
    | {
        call: SubagentCall;
        readonly appThread: OrchestrationV2AppThread;
        turns: number;
        prompt: string | undefined;
        queued: string | undefined;
      }
    | undefined;
  readonly wakes: Array<Wake>;
  readonly reports: Map<
    string,
    {
      readonly inboxId: string;
      readonly childId: string;
      readonly report: BackgroundWorkReport;
      readonly text: string;
    }
  >;
  readonly stoppedChildren: Set<string>;
  readonly strandedSteers: Set<string>;
  mcp:
    | { readonly name: string; readonly directory: string; readonly credential: string }
    | undefined;
  instructions: string | undefined;
}

export type TurnTerminal =
  | { readonly status: "completed" | "interrupted" }
  | { readonly status: "failed"; readonly failure: ReturnType<typeof makeProviderFailure> };

export type Rule = Permission.Rule;
export type RulesPolicy = Pick<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  "runtimeMode" | "interactionMode"
>;
export type NativeForm = EventOf<"form.created">["data"]["form"];

export interface PendingRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly sessionId: string;
  answering: boolean;
  readonly native:
    | {
        readonly type: "permission";
        readonly id: string;
        readonly action: string;
        readonly resources: ReadonlyArray<string>;
        readonly save: ReadonlyArray<string>;
      }
    | { readonly type: "form"; readonly id: string; readonly form: NativeForm };
}
export type ModelRef = ReturnType<typeof Model.Ref.make>;
