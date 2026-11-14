/**
 * Environment fixtures for ProviderTurnStartService tests: path helpers, the
 * worktree-location layer, and the harness input contract. Independent of the
 * main testkit so callers evaluated at module scope never observe a
 * half-initialised module.
 */
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type MessageId,
  type NodeId,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as GitWorkflow from "../git/GitWorkflowService.ts";

export const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

export const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";

export const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};

export const layerWorktreeLocation = (worktreesDir = managedWorktreesDir) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(),
  );

export interface LocalCommandHarnessInput {
  readonly text: string;
  readonly worktreePath?: string;
  readonly worktreesDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly resumeFailure?: ProviderAdapter.ProviderAdapterV2Error;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    readonly interruptFailure?: boolean;
    readonly interruptCurrentRun?: boolean;
  };
  /**
   * A side chat whose context targets this run, an earlier run that failed or was cancelled before
   * the provider, or an earlier run that delivered it. `nativeForkFrom` plans a native fork of the
   * parent. `switchedProvider` puts the earlier run and its context on another provider thread.
   */
  readonly sideChat?: {
    readonly contextRun: "current" | "failed" | "cancelled" | "delivered";
    readonly nativeForkFrom?: "idle" | "busy";
    readonly switchedProvider?: boolean;
  };
}

export function makeHarnessUserMessage(deps: {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly text: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ThreadProjection["messages"][number] {
  const { messageId, threadId, runId, rootNodeId, text, now } = deps;
  return {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
}
