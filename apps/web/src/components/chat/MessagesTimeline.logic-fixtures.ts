import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  CheckpointRef,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  workEntryDisplayIndicatesToolFailure,
  type TimelineEntry,
} from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { TurnDiffSummary } from "../../types";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  timelineTurnFoldRunIdsByEntryId,
  deriveMessagesTimelineRowsWithState,
  shouldCollapseUserMessage,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

export {
  CheckpointRef,
  DateTime,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  describe,
  expect,
  it,
  makeStreamingTimelineFixture,
  resolveAssistantMessageCopyState,
  serializeAssistantCitation,
  shouldCollapseUserMessage,
  timelineTurnFoldRunIdsByEntryId,
  workEntryDisplayIndicatesToolFailure,
  workEntryDisplayLabel,
};

export type {
  MessagesTimelineRow,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  TimelineEntry,
  TurnDiffSummary,
  WorktreeSetupSnapshot,
};
