// Generated from T3 service schemas by apps/server/scripts/extensionHostApi.ts.
import type { Json } from "./index.ts";

export type Wire1 =
  | "gray"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "rose";

export type Wire2 = string | undefined;

export type Wire4 = unknown | undefined;

export type Wire5 =
  | globalThis.ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
  | { readonly [x: string]: unknown };

export type Wire3 = {
  readonly provider?: Wire4;
  readonly instanceId?: Wire4;
  readonly model: unknown;
  readonly options?: Wire5 | null | undefined;
};

export type Wire6 = "local" | "worktree";

export type Wire7 = boolean | undefined;

export type Wire9 = string | undefined;

export type Wire8 = {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly icon: "play" | "test" | "lint" | "configure" | "build" | "debug";
  readonly runOnWorktreeCreate: boolean;
  readonly runOnSettle?: Wire7;
  readonly stopOnSettle?: Wire7;
  readonly async?: Wire7;
  readonly previewUrl?: Wire9;
  readonly autoOpenPreview?: Wire7;
};

export type Wire11 = "user" | "agent" | "system";

export type Wire12 = "web" | "mobile" | "mcp" | "provider" | "server";

export type Wire13 = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export type Wire14 = "default" | "plan";

export type Wire15 = {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
};

export type Wire17 = "manual" | "created" | "agent" | "stack" | "stack-dismissed";

export type Wire19 = "open" | "closed" | "merged";

export type Wire20 = number | undefined;

export type Wire18 = {
  readonly state: Wire19;
  readonly title: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly isDraft: boolean;
  readonly updatedAt: string | null;
  readonly syncedAt: string;
  readonly closedAt?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
  readonly author?:
    | {
        readonly isBot?: Wire7;
        readonly login: string;
        readonly name: string | null;
        readonly avatarUrl: string | null;
      }
    | null
    | undefined;
  readonly additions?: Wire20;
  readonly deletions?: Wire20;
  readonly changedFiles?: Wire20;
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required" | null | undefined;
  readonly checksState?: "passing" | "failing" | "pending" | null | undefined;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown" | undefined;
  readonly rebaseRequired?: Wire7;
};

export type Wire21 = {
  readonly kind: "native";
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: globalThis.ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly state: Wire19;
  }>;
};

export type Wire22 =
  | {
      readonly startedAt: string;
      readonly headSha: string | null;
      readonly failedChecks: globalThis.ReadonlyArray<string>;
      readonly passed: boolean;
      readonly passedChecks?: globalThis.ReadonlyArray<string> | undefined;
      readonly owedChecks?: globalThis.ReadonlyArray<string> | undefined;
      readonly awaitingApproval?: globalThis.ReadonlyArray<string> | undefined;
      readonly approvalAnnounced?: Wire7;
      readonly remarksThrough: string;
      readonly remarkIds: globalThis.ReadonlyArray<string>;
      readonly conflicting: boolean;
      readonly rebaseRequired?: Wire7;
      readonly mergeQueueRemovalId?: string | null | undefined;
      readonly wakes: number;
      readonly awaitingBaseline?: "all" | "checks" | undefined;
      readonly checksAwaitedSince?: string | null | undefined;
      readonly checksPending?: Wire7;
      readonly until?: "merged" | undefined;
    }
  | undefined;

export type Wire16 = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly repositoryWebUrl?: Wire9;
  readonly source: Wire17;
  readonly linkedAt: string;
  readonly snapshot: Wire18 | null;
  readonly stack: Wire21 | null;
  readonly watch?: Wire22;
  readonly endedWatch?: Wire22;
};

export type Wire24 = "manual" | "agent";

export type Wire23 = {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly projectId: string;
  readonly url: string;
  readonly source: Wire24;
  readonly linkedAt: string;
  readonly displayKey: string;
  readonly title: string;
};

export type Wire25 = {
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly rootThreadId: string;
  readonly sideChat?: Wire7;
  readonly workflowStep?: Wire7;
};

export type Wire26 =
  | { readonly type: "run"; readonly threadId: string; readonly runId: string }
  | { readonly type: "node"; readonly nodeId: string }
  | {
      readonly type: "provider_thread";
      readonly providerThreadId: string;
      readonly providerTurnId?: Wire9;
    }
  | null;

export type Wire27 = "native" | "v1_import" | undefined;

export type Wire29 =
  | "read-only"
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access"
  | undefined;

export type Wire28 =
  | { readonly sessionId: string; readonly label: string; readonly access?: Wire29 }
  | undefined;

export type Wire30 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;

export type Wire31 =
  | {
      readonly environmentId: string;
      readonly runId: string;
      readonly workflow: string;
      readonly step: string;
    }
  | undefined;

export type Wire32 =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type Wire33 =
  | "usage_limit"
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

export type Wire35 = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";

export type Wire34 = Wire35 | "dynamic_tool_call" | "user_input" | "auth_refresh";

export type Wire36 = "user" | "assistant" | "system";

export type Wire38 = string | undefined;

export type Wire39 = true | undefined;

export type Wire37 =
  | {
      readonly command?: Wire38;
      readonly itemId?: Wire9;
      readonly sourceThreadId?: Wire9;
      readonly taskId: string;
      readonly description?: Wire9;
      readonly parentTaskId?: Wire9;
      readonly nativeItemId?: Wire9;
      readonly runId?: Wire9;
      readonly awaited?: Wire39;
      readonly kind: "subagent";
      readonly providerInstanceId?: string | undefined;
      readonly childThreadId?: Wire9;
    }
  | {
      readonly command?: Wire38;
      readonly itemId?: Wire9;
      readonly sourceThreadId?: Wire9;
      readonly taskId: string;
      readonly description?: Wire9;
      readonly parentTaskId?: Wire9;
      readonly nativeItemId?: Wire9;
      readonly runId?: Wire9;
      readonly awaited?: Wire39;
      readonly kind: "command";
    }
  | {
      readonly command?: Wire38;
      readonly itemId?: Wire9;
      readonly sourceThreadId?: Wire9;
      readonly taskId: string;
      readonly description?: Wire9;
      readonly parentTaskId?: Wire9;
      readonly nativeItemId?: Wire9;
      readonly runId?: Wire9;
      readonly awaited?: Wire39;
      readonly kind: "monitor";
    }
  | {
      readonly command?: Wire38;
      readonly itemId?: Wire9;
      readonly sourceThreadId?: Wire9;
      readonly taskId: string;
      readonly description?: Wire9;
      readonly parentTaskId?: Wire9;
      readonly nativeItemId?: Wire9;
      readonly runId?: Wire9;
      readonly awaited?: Wire39;
      readonly kind: "background_task";
    }
  | {
      readonly command?: Wire38;
      readonly itemId?: Wire9;
      readonly sourceThreadId?: Wire9;
      readonly taskId: string;
      readonly description?: Wire9;
      readonly parentTaskId?: Wire9;
      readonly nativeItemId?: Wire9;
      readonly runId?: Wire9;
      readonly awaited?: Wire39;
      readonly kind?: string | undefined;
    };

export type Wire40 = {
  readonly objective: string;
  readonly status:
    | "active"
    | "paused"
    | "blocked"
    | "usage_limited"
    | "budget_limited"
    | "complete";
  readonly tokensUsed?: Wire20;
  readonly tokenBudget?: number | null | undefined;
  readonly timeUsedSeconds?: Wire20;
  readonly checks?: Wire20;
  readonly lastCheck?: Wire38;
};

export type Wire41 = {
  readonly requestId?: Wire9;
  readonly runId: string;
  readonly resetAt: string;
  readonly autoResume: boolean;
  readonly snooze?: Wire7;
};

export type Wire42 = globalThis.ReadonlyArray<string> | undefined;

export type Wire43 =
  | {
      readonly openedAt: number;
      readonly score: number;
      readonly picks: globalThis.ReadonlyArray<{ readonly query: string; readonly at: number }>;
    }
  | null
  | undefined;

export type Wire45 = "renamed" | "unchanged" | "failed";

export type Wire44 = {
  readonly status: Wire45;
  readonly message?: Wire38;
  readonly requestId: string;
  readonly completedAt: string;
};

export type Wire10 = {
  readonly createdBy: Wire11;
  readonly creationSource: Wire12;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelSelection: Wire3;
  readonly runtimeMode: Wire13;
  readonly interactionMode: Wire14;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly linkedPullRequest?: Wire15 | null | undefined;
  readonly pullRequests?: globalThis.ReadonlyArray<Wire16> | undefined;
  readonly branchPullRequest?: Wire15 | null | undefined;
  readonly issues?: globalThis.ReadonlyArray<Wire23> | undefined;
  readonly lineage: Wire25;
  readonly forkedFrom: Wire26 | null;
  readonly activeProviderThreadId: string | null;
  readonly historyOrigin?: Wire27;
  readonly linkOrigin?: Wire28;
  readonly delegatedFrom?: Wire30;
  readonly workflowRun?: Wire31;
  readonly latestRunId: string | null;
  readonly latestRunRequestedAt?: string | null | undefined;
  readonly latestRunStartedAt?: string | null | undefined;
  readonly latestRunCompletedAt?: string | null | undefined;
  readonly latestRunStopRequested?: Wire7;
  readonly latestRunBackgroundWake?: Wire7;
  readonly activeRunId: string | null;
  readonly activityRunStartedAt?: string | null | undefined;
  readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null | undefined;
  readonly blockedOnThreadWait?: Wire7;
  readonly status: "idle" | Wire32;
  readonly lastError?: string | null | undefined;
  readonly lastErrorClass?: Wire33 | null | undefined;
  readonly lastErrorCode?: string | null | undefined;
  readonly usageLimitResetAt?: string | null | undefined;
  readonly pendingRuntimeRequest: {
    readonly id: string;
    readonly kind: Wire34;
    readonly createdAt: string;
    readonly blocking?: Wire7;
    readonly userOnly?: Wire7;
  } | null;
  readonly pendingGuestMessageCount?: Wire20;
  readonly latestVisibleMessage: {
    readonly id: string;
    readonly role: Wire36;
    readonly text: string;
    readonly updatedAt: string;
  } | null;
  readonly latestUserMessageAt: string | null;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks?: globalThis.ReadonlyArray<Wire37> | undefined | undefined;
  readonly providerInstanceHistory?: globalThis.ReadonlyArray<string> | undefined | undefined;
  readonly goal?: Wire40 | null | undefined;
  readonly itemCount: number;
  readonly visibleItemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt?: string | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
  readonly snoozedAt?: string | null | undefined;
  readonly limitRecovery?: Wire41 | null | undefined;
  readonly pinnedAt?: string | null | undefined;
  readonly autoSettleDisabledAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
  readonly tags?: Wire42;
  readonly lastVisitedAt?: string | null | undefined;
  readonly opens?: Wire43;
  readonly titleRegeneration?:
    | { readonly requestId: string; readonly startedAt: string }
    | null
    | undefined;
  readonly lastTitleRegeneration?: Wire44 | null | undefined;
  readonly deletedAt: string | null;
};

export type Wire48 = {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly state?: {
    readonly active?: Wire7;
    readonly busy?: Wire7;
    readonly checked?: "on" | "off" | "mixed" | undefined;
    readonly editable?: Wire7;
    readonly enabled?: Wire7;
    readonly expanded?: Wire7;
    readonly focused?: Wire7;
    readonly selected?: Wire7;
    readonly visible?: Wire7;
  };
  readonly actions?: globalThis.ReadonlyArray<string>;
  readonly children: globalThis.ReadonlyArray<Wire48>;
};

export type Wire47 = {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?:
    | {
        readonly kind: "snap-shot";
        readonly capturedAt: string;
        readonly appName: string;
        readonly windowTitle: string;
        readonly accessibleText?: string | undefined;
        readonly accessibility?:
          | { readonly format: "flat-text"; readonly text: string; readonly truncated: boolean }
          | {
              readonly format: "element-tree";
              readonly coordinateSpace: "captured-image";
              readonly imageSize: { readonly width: number; readonly height: number };
              readonly truncated: boolean;
              readonly root: Wire48;
            }
          | undefined;
        readonly appIdentifier?: string | undefined;
        readonly appIconDataUrl?: string | undefined;
      }
    | undefined;
};

export type Wire49 = {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: { readonly _tag: "pasted-text" } | undefined;
};

export type Wire46 =
  | Wire47
  | Wire49
  | {
      readonly type: string;
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    };

export type Wire50 = string | undefined;

export type Wire52 = string | undefined;

export type Wire51 =
  | { readonly type: "root"; readonly branch?: Wire52 }
  | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch?: Wire52 }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: Wire52;
      readonly startFromOrigin?: Wire7;
      readonly repositories?: globalThis.ReadonlyArray<{ readonly path: string }> | undefined;
    }
  | undefined;

export type Wire54 = "strong" | "weak" | "none";

export type Wire53 = {
  readonly driver: string;
  readonly nativeId: string | null;
  readonly strength: Wire54;
  readonly fingerprint?: Wire9;
  readonly ordinal?: Wire20;
};

export type Wire55 =
  | {
      readonly environmentId: string;
      readonly threadId: string;
      readonly label: string;
      readonly title?: Wire38;
      readonly runId?: Wire9;
      readonly stoppedThere?: Wire7;
      readonly stopCount?: Wire20;
    }
  | undefined;

export type Wire56 = Wire3 | undefined;

export type Wire57 = string | undefined;

export type Wire58 = number | undefined;

export type Wire59 = {
  readonly cursorStoreCwd?: Wire9;
  readonly modelSelection?: Wire56;
  readonly title?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly itemIdentityVersion?: 2 | undefined;
  readonly forkHeadMessageId?: Wire9;
  readonly claudeAttachmentBudget?:
    | { readonly bytesUsed: number; readonly pagesUsed: number }
    | undefined;
  readonly claudeDeliveredAppContext?: { readonly [x: string]: string } | undefined;
};

export type Wire60 = Wire53 | undefined;

export type Wire61 =
  | {
      readonly usedTokens: number;
      readonly maxTokens?: number | null | undefined;
      readonly inputTokens?: Wire20;
      readonly cachedInputTokens?: Wire20;
      readonly outputTokens?: Wire20;
      readonly reasoningOutputTokens?: Wire20;
      readonly promptCacheTtlMs?: Wire58;
      readonly autoCompactThreshold?: Wire58;
      readonly promptCacheExpiresAt?: Wire38;
      readonly updatedAt: string;
    }
  | undefined;

export type Wire62 = globalThis.ReadonlyArray<string> | undefined;

export type Wire63 = { readonly inputTokens: number; readonly outputTokens: number } | undefined;

export type Wire65 = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export type Wire64 = Wire65 | undefined;

export type Wire67 = { readonly [x: string]: unknown };

export type Wire66 = Wire67 | undefined;

export type Wire71 = "completed" | "failed" | "cancelled" | "updated" | "unknown";

export type Wire70 = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly watchStartedAt: string;
  readonly headSha: string | null;
  readonly watchEnded?: Wire7;
  readonly section?:
    | { readonly text: string; readonly outcome: Wire71; readonly summary: string }
    | undefined;
};

export type Wire69 =
  | {
      readonly kind: "delegated_task";
      readonly taskIds: globalThis.ReadonlyArray<string>;
      readonly childThreadId?: Wire9;
    }
  | { readonly kind: "background_task"; readonly work: "subagent"; readonly childThreadId?: Wire9 }
  | { readonly kind: "background_command" }
  | { readonly kind: "subagent"; readonly childThreadId?: Wire9 }
  | { readonly kind: "command" }
  | {
      readonly kind: "monitor";
      readonly pullRequest?: Wire70 | undefined;
      readonly otherPullRequests?: globalThis.ReadonlyArray<Wire70> | undefined;
    }
  | { readonly kind: "background_task" }
  | { readonly kind: "system" }
  | { readonly kind?: string | undefined };

export type Wire68 =
  | {
      readonly source: Wire69;
      readonly outcome: Wire71;
      readonly summary: string;
      readonly detail?: Wire38;
    }
  | undefined;

export type Wire72 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;

export type Wire73 = "beforeCacheExpires" | "onReturn" | undefined;

export type Wire74 =
  | {
      readonly version: 1;
      readonly guest?:
        | {
            readonly guestMessageId: string;
            readonly name: string;
            readonly text: string;
            readonly shareId?: Wire9;
          }
        | undefined;
      readonly records: globalThis.ReadonlyArray<unknown>;
    }
  | undefined;

export type Wire75 = string | null;

export type Wire76 = "draft" | "active" | "completed" | "superseded";

export type Wire77 = true | undefined;

export type Wire78 = {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
  readonly durationAnchorAt?: Wire38;
  readonly durationMs?: Wire20;
};

export type Wire80 = {
  readonly cursor: string;
  readonly itemCount: number;
  readonly lastOrdinal: number;
};

export type Wire81 = "browser" | "computer" | undefined;

export type Wire82 =
  | {
      readonly _tag: "website";
      readonly pageUrl: string;
      readonly faviconUrl?: string | undefined;
      readonly faviconUrlDark?: string | undefined;
    }
  | {
      readonly _tag: "native-app";
      readonly app:
        | { readonly _tag: "app-id"; readonly appId: string }
        | { readonly _tag: "display-name"; readonly displayName: string };
    }
  | {
      readonly _tag: "themed-logo";
      readonly logoUrl: string;
      readonly logoUrlDark?: string | undefined;
    }
  | undefined;

export type Wire83 =
  | {
      readonly key: string;
      readonly name: string;
      readonly kind: "browser" | "computer" | "integration";
      readonly icon?: Wire82;
    }
  | undefined;

export type Wire84 = string | null;

export type Wire85 = string | null;

export type Wire86 = string | null;

export type Wire87 = string | null;

export type Wire88 = Wire53 | null;

export type Wire89 = string | null;

export type Wire90 =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Wire91 = string | null;

export type Wire92 = string | null;

export type Wire93 = string | null;

export type Wire79 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "notification";
  readonly source: Wire69;
  readonly outcome: Wire71;
  readonly summary: string;
  readonly detail?: Wire38;
};

export type Wire94 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly createdBy: Wire11;
  readonly creationSource: Wire12;
  readonly type: "user_message";
  readonly messageId: string;
  readonly scheduledTaskId?: Wire9;
  readonly senderThreadId?: Wire9;
  readonly linkedSender?: Wire72;
  readonly idleCompaction?: Wire73;
  readonly workflowScript?: Wire7;
  readonly freshContext?: Wire7;
  readonly inputIntent: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
  readonly text: string;
  readonly textOmitted?: true;
  readonly context?: Wire74;
  readonly attachments: globalThis.ReadonlyArray<Wire46>;
  readonly modelSwitch?: { readonly from: Wire3; readonly to: Wire3 } | undefined;
};

export type Wire95 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "assistant_message";
  readonly phase?: "commentary" | "partial_answer" | "final_answer" | undefined;
  readonly delivery?: "async" | undefined;
  readonly messageId: string;
  readonly text: string;
  readonly textOmitted?: true;
  readonly attachments?: globalThis.ReadonlyArray<Wire46> | undefined;
  readonly streaming: boolean;
};

export type Wire96 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "reasoning";
  readonly text: string;
  readonly streaming: boolean;
};

export type Wire97 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "proposed_plan";
  readonly planId: string;
  readonly markdown: string;
  readonly streaming: boolean;
};

export type Wire98 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "todo_list";
  readonly planId: string;
  readonly steps: globalThis.ReadonlyArray<Wire78>;
  readonly explanation?: Wire38;
};

export type Wire100 = { readonly [x: string]: globalThis.ReadonlyArray<Wire47 | Wire49> };

export type Wire99 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "user_input_request";
  readonly requestId: string;
  readonly questions: globalThis.ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: globalThis.ReadonlyArray<{
      readonly label: string;
      readonly description: string;
      readonly value?: Wire38;
      readonly preview?: Wire38;
    }>;
    readonly multiSelect?: Wire7;
    readonly allowCustomAnswer?: Wire7;
    readonly initialAnswer?: Wire38;
    readonly required?: Wire7;
  }>;
  readonly questionAnswer?:
    | {
        readonly requestId: string;
        readonly questionTextById?: { readonly [x: string]: string } | undefined;
        readonly answers: Wire67;
        readonly attachmentsByQuestionId: Wire100;
      }
    | undefined;
  readonly responseMode?: "message" | undefined;
};

export type Wire101 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "file_change";
  readonly fileName: string;
  readonly additions?: Wire20;
  readonly deletions?: Wire20;
  readonly diffStr?: Wire38;
  readonly oldStr?: Wire38;
  readonly newStr?: Wire38;
  readonly changes?:
    | globalThis.ReadonlyArray<{
        readonly operation: string;
        readonly path: string;
        readonly oldPath?: Wire9;
        readonly fileType?: Wire9;
        readonly mimeType?: Wire9;
      }>
    | undefined;
};

export type Wire102 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "command_execution";
  readonly input: string;
  readonly output?: Wire38;
  readonly outputOmitted?: Wire7;
  readonly outputIndicatesFailure?: Wire7;
  readonly exitCode?: number | undefined;
  readonly monitor?: Wire7;
  readonly completionWake?: "always" | undefined;
};

export type Wire103 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "file_search";
  readonly pattern?: Wire38;
  readonly results?:
    | globalThis.ReadonlyArray<{
        readonly fileName: string;
        readonly line?: Wire58;
        readonly column?: Wire58;
        readonly preview?: Wire38;
      }>
    | undefined;
};

export type Wire104 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "web_search";
  readonly patterns?: globalThis.ReadonlyArray<string> | undefined;
  readonly results?:
    | globalThis.ReadonlyArray<{
        readonly title?: Wire38;
        readonly url?: Wire9;
        readonly snippet?: Wire38;
      }>
    | undefined;
};

export type Wire105 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "approval_request";
  readonly requestId: string;
  readonly requestKind: Wire35;
  readonly prompt?: Wire38;
  readonly reason?: Wire38;
  readonly fullAccessOverride?: "ask_rule" | "provider_check" | undefined;
  readonly appName?: Wire38;
  readonly pushHooks?:
    | {
        readonly branch: string;
        readonly files: globalThis.ReadonlyArray<string>;
        readonly commands: globalThis.ReadonlyArray<{
          readonly name: string;
          readonly command: string;
        }>;
      }
    | undefined;
  readonly options?:
    | globalThis.ReadonlyArray<{
        readonly decision: Wire65;
        readonly label: string;
        readonly warning?: Wire9;
      }>
    | undefined;
};

export type Wire107 = {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
};

export type Wire108 = {
  readonly count: number;
  readonly additions: number;
  readonly deletions: number;
};

export type Wire106 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "checkpoint";
  readonly checkpointId: string;
  readonly scopeId: string;
  readonly files: globalThis.ReadonlyArray<Wire107>;
  readonly filesTotal?: Wire108;
  readonly filesOmitted?: true;
};

export type Wire109 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "run_interrupt_request";
  readonly message: string;
  readonly unresponsiveAt?: string;
};

export type Wire110 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "run_interrupt_result";
  readonly message: string;
};

export type Wire111 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "system_notice";
  readonly message: string;
  readonly level?: "info" | "warning" | "error" | undefined;
  readonly mcpSignIn?: { readonly server: string } | undefined;
};

export type Wire113 = {
  readonly class: Wire33;
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean | null;
  readonly resetAt?: string | null | undefined;
  readonly verificationUrl?: string;
};

export type Wire112 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "error";
  readonly failure: Wire113;
  readonly retry?:
    | {
        readonly attempt: number;
        readonly maxAttempts: number | null;
        readonly retryDelayMs: number | null;
      }
    | undefined;
};

export type Wire114 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "compaction";
  readonly driver: string | null;
  readonly summary?: Wire38;
  readonly beforeTokenCount?: Wire20;
  readonly afterTokenCount?: Wire20;
};

export type Wire115 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "handoff";
  readonly contextHandoffId: string;
  readonly fromProviderThreadIds: globalThis.ReadonlyArray<string>;
  readonly toProviderThreadId: string;
  readonly fromProviderInstanceIds: globalThis.ReadonlyArray<string>;
  readonly toProviderInstanceId: string;
  readonly fromModelSelections?: globalThis.ReadonlyArray<Wire3> | undefined;
  readonly toModel?: Wire38;
  readonly strategy:
    | "delta_since_target_last_seen"
    | "fork_delta_summary"
    | "full_thread_summary"
    | "checkpoint_summary"
    | "manual_context";
  readonly summary?: Wire38;
};

export type Wire116 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId?: Wire9;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "fork";
  readonly source:
    | { readonly type: "run"; readonly threadId: string; readonly runId: string }
    | { readonly type: "node"; readonly nodeId: string }
    | {
        readonly type: "provider_thread";
        readonly providerThreadId: string;
        readonly providerTurnId?: Wire9;
      };
  readonly targetThreadId: string;
};

export type Wire117 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "thread_created";
  readonly targetThreadId: string;
  readonly targetRunId: string | null;
  readonly targetProviderInstanceId: string;
  readonly targetModel: string;
};

export type Wire118 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "secret_request";
  readonly label: string;
  readonly reason: string;
  readonly url?: Wire38;
  readonly placeholder?: Wire38;
  readonly delivery?: "file" | undefined;
  readonly fields?:
    | globalThis.ReadonlyArray<{
        readonly name: string;
        readonly label: string;
        readonly placeholder?: Wire38;
        readonly secret?: Wire7;
      }>
    | undefined;
  readonly secretStatus: "pending" | "saved" | "declined" | "cancelled";
};

export type Wire119 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "link_request";
  readonly url?: Wire9;
  readonly reason: string;
  readonly environmentId?: Wire9;
  readonly label?: Wire38;
  readonly hint?: Wire38;
  readonly requestedAccess?: Wire29;
  readonly linkStatus: "pending" | "linked" | "declined" | "cancelled" | "failed";
  readonly linkedEnvironmentId?: Wire9;
  readonly linkedLabel?: Wire38;
  readonly linkedAccess?: Wire29;
  readonly failure?: Wire38;
};

export type Wire121 = {
  readonly turns: number;
  readonly textTurns: number;
  readonly truncated: boolean;
  readonly entries: globalThis.ReadonlyArray<{
    readonly turn: number;
    readonly type: "user" | "assistant" | "tool";
    readonly tool?: string;
    readonly outcome?: "ok" | "error" | "unfinished";
    readonly durationMs?: number;
    readonly length?: number;
    readonly text?: string;
  }>;
};

export type Wire120 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "feedback_request";
  readonly preview: {
    readonly kind: "bug" | "confusing" | "missing_capability" | "wrong_docs" | "other";
    readonly subject: string;
    readonly expected: string;
    readonly actual: string;
    readonly workaround: string;
    readonly trace: Wire121 | null;
  };
  readonly conversationTrace?: Wire121;
  readonly feedbackStatus: "pending" | "sent" | "declined" | "cancelled";
};

export type Wire122 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "subagent";
  readonly subagentId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly childThreadId: string | null;
  readonly remoteChild?: Wire55;
  readonly prompt: string;
  readonly progress?: Wire38;
  readonly result: string | null;
  readonly promptOmitted?: true;
  readonly resultOmitted?: true;
};

export type Wire123 = {
  readonly deferredWork?: Wire80;
  readonly toolNonExecutionKind?: Wire38;
  readonly toolSurface?: Wire81;
  readonly toolIcon?: Wire82;
  readonly toolSource?: Wire83;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire84;
  readonly nodeId: Wire85;
  readonly providerThreadId: Wire86;
  readonly providerTurnId: Wire87;
  readonly nativeItemRef: Wire88;
  readonly parentItemId: Wire89;
  readonly ordinal: number;
  readonly status: Wire90;
  readonly title: Wire91;
  readonly startedAt: Wire92;
  readonly completedAt: Wire93;
  readonly updatedAt: string;
  readonly type: "dynamic_tool";
  readonly toolName: string | null;
  readonly viewedImagePath?: Wire9;
  readonly input: unknown;
  readonly output?: Wire4;
  readonly outputOmitted?: Wire7;
};

export type Wire124 = {
  readonly threadId: string;
  readonly runId?: Wire9;
  readonly checkpointId?: Wire9;
  readonly turnItemId?: Wire9;
  readonly providerThreadRef?: Wire60;
  readonly providerTurnRef?: Wire60;
};

export type Wire125 =
  | { readonly type: "latest_stable" }
  | { readonly type: "run"; readonly runId: string }
  | { readonly type: "checkpoint"; readonly checkpointId: string };

export type Wire126 = globalThis.ReadonlyArray<{
  readonly provider: string;
  readonly model: string;
}>;

export type Wire127 = {
  readonly [x: string]: {
    readonly hiddenModels?: globalThis.ReadonlyArray<string> | undefined;
    readonly modelOrder?: globalThis.ReadonlyArray<string> | undefined;
  };
};

export type Wire130 = "any-local-files" | "uncommitted-changes" | "tracked-changes";

export type Wire129 = Wire130 | undefined;

export type Wire131 = number | null;

export type Wire133 = number | null;

export type Wire132 = Wire133 | undefined;

export type Wire128 =
  | { readonly mode: "off" }
  | {
      readonly mode: "custom";
      readonly rules: {
        readonly worktreeKeepWhen?: Wire129;
        readonly worktreeAfterDays: Wire131;
        readonly worktreeSettledAfterDays?: Wire132;
        readonly worktreeOnMerge: boolean;
        readonly worktreeOnDelete: boolean;
        readonly worktreeUnchanged: boolean;
      };
    }
  | null;

export type Wire134 = Wire131 | undefined;

export type Wire135 = "turn" | "paragraph";

export type Wire136 = "off" | "on-request" | "auto";

export type Wire139 = { readonly provider: string; readonly reference: string };

export type Wire138 = string | Wire139;

export type Wire137 = Wire138 | undefined;

export type Wire140 = "auto" | "cpu" | string;

export type Wire141 = "never" | "immediately" | "min_2" | "min_5" | "min_10" | "min_15" | "hour_1";

export type Wire142 = globalThis.ReadonlyArray<{
  readonly term: string;
  readonly aliases: globalThis.ReadonlyArray<string>;
}>;

export type Wire143 = Wire3 | null;

export type Wire144 = globalThis.ReadonlyArray<Wire8>;

export type Wire145 = Wire3 | null;

export type Wire146 = Wire3 | null;

export type Wire149 = "repo_conventions" | "conventional_commits" | "custom";

export type Wire148 = {
  readonly mode?: Wire149 | undefined;
  readonly customInstructions?: Wire38;
  readonly followChangeRequestTemplates?: Wire7;
};

export type Wire147 = Wire148 | string;

export type Wire150 = "static" | "semantic" | "custom";

export type Wire152 = "merge" | "squash" | "rebase" | "fast-forward";

export type Wire151 = Wire152 | null;

export type Wire153 = number | null;

export type Wire154 = { readonly [x: string]: { readonly enabled?: boolean } };

export type Wire155 = globalThis.ReadonlyArray<{
  readonly kind?: "ssh";
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly identityFile?: Wire9;
  readonly port?: number | undefined;
}>;

export type Wire156 = globalThis.ReadonlyArray<{
  readonly kind: "eas";
  readonly id: string;
  readonly label: string;
  readonly appId?: Wire9;
  readonly accessToken?: Wire138;
  readonly maxSessionMinutes?: number;
  readonly idleMinutes?: number;
  readonly maxConcurrentSessions?: number;
}>;

export type Wire157 = globalThis.ReadonlyArray<{
  readonly kind: "simlock";
  readonly id: string;
  readonly label: string;
  readonly gatewayUrl: string;
  readonly agentToken?: Wire138;
  readonly maxLeases?: number;
  readonly maxLeaseMinutes?: number;
}>;

export type Wire159 = "onReturn" | "beforeCacheExpires" | "off";

export type Wire158 = boolean | Wire159;

export type Wire160 =
  | { readonly kind: "after"; readonly minutes: number }
  | {
      readonly kind: "at";
      readonly day:
        | "today"
        | "tomorrow"
        | "monday"
        | "tuesday"
        | "wednesday"
        | "thursday"
        | "friday"
        | "saturday"
        | "sunday";
      readonly time: string;
    };

export type Wire161 = "balanced" | "performance" | "battery-saver" | "custom";

export type Wire162 = "balanced" | "performance" | "battery-saver";

export type Wire163 = {
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly hostPowerMonitorActiveInterval?: number;
  readonly hostPowerMonitorIdleInterval?: number;
  readonly pauseWhenHostLocked?: boolean;
  readonly pauseWhenHostLowPower?: boolean;
  readonly pauseWhenClientLowPower?: boolean;
  readonly pauseWhenOnBattery?: boolean;
};

export type Wire164 = number | undefined;

export type Wire165 = "" | "light" | "dark" | "system";

export type Wire166 = {
  readonly driver: string;
  readonly displayName?: Wire9;
  readonly accentColor?: Wire9;
  readonly environment?: globalThis.ReadonlyArray<{
    readonly name: string;
    readonly value?: Wire38;
    readonly sensitive?: Wire7;
    readonly valueRedacted?: boolean;
    readonly secret?: Wire139;
  }>;
  readonly enabled?: boolean;
  readonly usageAccess?: "allowed" | "denied";
  readonly config?: unknown;
};

export type Wire167 = { readonly [x: string]: unknown };

export type Wire168 = {
  readonly kind: "cliproxy" | "http";
  readonly label?: Wire9;
  readonly url: string;
  readonly managementKey?: Wire137;
  readonly enabled?: Wire7;
};

export type Wire169 = {
  readonly kind: "openaiCompatible" | "anthropic";
  readonly label?: Wire9;
  readonly baseUrl: string;
  readonly apiKey?: Wire137;
  readonly enabled?: Wire7;
};

export type Wire170 = number | "unlimited";

export type Wire171 = {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly cacheReadCostPerMillionTokens?: number;
  readonly cacheWriteCostPerMillionTokens?: number;
};

export type Wire172 = globalThis.ReadonlyArray<{
  readonly term: string;
  readonly aliases: globalThis.ReadonlyArray<string>;
}>;

export type ProjectSnapshot = {
  readonly projects: globalThis.ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repositoryIdentity?:
      | {
          readonly canonicalKey: string;
          readonly locator: {
            readonly source: "git-remote";
            readonly remoteName: string;
            readonly remoteUrl: string;
          };
          readonly webUrl?: string;
          readonly rootPath?: string;
          readonly displayName?: string;
          readonly provider?: string;
          readonly owner?: string;
          readonly name?: string;
          readonly origin?: {
            readonly canonicalKey: string;
            readonly remoteUrl?: string;
            readonly displayName?: string;
          };
        }
      | null
      | undefined;
    readonly faviconPath?: string | null | undefined;
    readonly projectIcon?:
      | {
          readonly kind: "lucide";
          readonly name: string;
          readonly color: Wire1;
          readonly monogramText?: Wire2;
          readonly monogram?: Wire2;
        }
      | { readonly kind: "emoji"; readonly emoji: string }
      | { readonly kind: "monogram"; readonly text: string; readonly color: Wire1 }
      | { readonly kind: string }
      | null
      | undefined;
    readonly defaultModelSelection: Wire3 | null;
    readonly defaultThreadEnvMode?: Wire6 | null | undefined;
    readonly autoPull?: Wire7;
    readonly scripts: globalThis.ReadonlyArray<Wire8>;
    readonly trackedFolders?:
      | globalThis.ReadonlyArray<{
          readonly path: string;
          readonly name: string;
          readonly discovered?: Wire7;
        }>
      | undefined;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deletedAt: string | null;
  }>;
  readonly updatedAt: string;
};

export type ThreadShellSnapshot = {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly threads: globalThis.ReadonlyArray<Wire10>;
  readonly archivedThreads: globalThis.ReadonlyArray<Wire10>;
};

export type ThreadSnapshot = {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly projection: {
    readonly thread: {
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly id: string;
      readonly projectId: string;
      readonly title: string;
      readonly providerInstanceId: string;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire13;
      readonly interactionMode: Wire14;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly linkedPullRequest?: Wire15 | null | undefined;
      readonly pullRequests?: globalThis.ReadonlyArray<Wire16> | undefined;
      readonly branchPullRequest?: Wire15 | null | undefined;
      readonly issues?: globalThis.ReadonlyArray<Wire23> | undefined;
      readonly activeProviderThreadId: string | null;
      readonly historyOrigin?: Wire27;
      readonly linkOrigin?: Wire28;
      readonly delegatedFrom?: Wire30;
      readonly workflowRun?: Wire31;
      readonly lineage: Wire25;
      readonly forkedFrom: Wire26;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly archivedAt: string | null;
      readonly settledOverride?: "settled" | "active" | null | undefined;
      readonly settledAt?: string | null | undefined;
      readonly unsettledAt?: string | null | undefined;
      readonly snoozedUntil?: string | null | undefined;
      readonly snoozedAt?: string | null | undefined;
      readonly lastSnoozeWakeAt?: string | null | undefined;
      readonly limitRecovery?: Wire41 | null | undefined;
      readonly guestShare?:
        | {
            readonly id: string;
            readonly host: string;
            readonly createdAt: string;
            readonly expiresAt: string;
            readonly guestName: string | null;
            readonly messages: globalThis.ReadonlyArray<{
              readonly id: string;
              readonly text: string;
              readonly status: "pending" | "sent" | "dismissed";
              readonly submittedAt: string;
              readonly attachments?: globalThis.ReadonlyArray<Wire46> | undefined;
            }>;
          }
        | null
        | undefined;
      readonly pinnedAt?: string | null | undefined;
      readonly autoSettleDisabledAt?: string | null | undefined;
      readonly pinOrderKey?: string | null | undefined;
      readonly activeOrderKey?: string | null | undefined;
      readonly tags?: Wire42;
      readonly lastVisitedAt?: string | null | undefined;
      readonly opens?: Wire43;
      readonly titleRegeneration?:
        | { readonly requestId: string; readonly startedAt: string }
        | null
        | undefined;
      readonly lastTitleRegeneration?: Wire44 | null | undefined;
      readonly titleRenamed?: Wire7;
      readonly rollbackRequestId?: Wire9;
      readonly rollbackFailure?:
        | { readonly requestId: string; readonly message: string }
        | null
        | undefined;
      readonly rollbackUnrestored?:
        | { readonly requestId: string; readonly repositories: globalThis.ReadonlyArray<string> }
        | null
        | undefined;
      readonly deletedAt: string | null;
    };
    readonly runs: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly ordinal: number;
      readonly providerInstanceId: string;
      readonly modelSelection: Wire3;
      readonly providerThreadId: string | null;
      readonly userMessageId: string;
      readonly rootNodeId: string | null;
      readonly activeAttemptId: string | null;
      readonly status: Wire32;
      readonly queuePosition?: number | null | undefined;
      readonly queueHeld?: Wire7;
      readonly explicitQueue?: true | undefined;
      readonly steerWhenReadyRunId?: Wire9;
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly checkpointId: string | null;
      readonly contextHandoffId: string | null;
      readonly restartContinuationOfRunId?: Wire9;
      readonly manualContinuationOfRunId?: Wire9;
      readonly usageLimitContinuationOfRunId?: Wire9;
      readonly delegatedTaskId?: Wire9;
      readonly workStartedAt?: Wire50;
      readonly restartCancelledBackgroundWork?:
        | globalThis.ReadonlyArray<{
            readonly kind: "subagent" | "shell" | "monitor" | "task";
            readonly label: string;
            readonly id?: Wire9;
            readonly awaited?: true | undefined;
          }>
        | undefined;
      readonly sourcePlanRef?: { readonly threadId: string; readonly planId: string } | undefined;
      readonly delegatedCompletion?:
        | {
            readonly disposition: "open" | "stopped" | "disposed";
            readonly reopenedAfterStop?: true;
            readonly nextGeneration: number;
            readonly delivery: {
              readonly generation: number;
              readonly messageId: string;
              readonly taskIds: globalThis.ReadonlyArray<string>;
            } | null;
          }
        | undefined;
      readonly workspacePreparation?: Wire51;
      readonly freshContext?: Wire7;
      readonly outputSchema?: { readonly [x: string]: Json } | undefined;
      readonly output?: { readonly value: Json; readonly submittedAt: string } | undefined;
    }>;
    readonly attempts: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly nativeThreadId?: Wire38;
      readonly runId: string;
      readonly attemptOrdinal: number;
      readonly rootNodeId: string;
      readonly providerInstanceId: string;
      readonly providerThreadId: string;
      readonly providerTurnId: string | null;
      readonly reason: "initial" | "steering_restart" | "retry" | "provider_recovery";
      readonly status:
        | "pending"
        | "running"
        | "completed"
        | "interrupted"
        | "failed"
        | "cancelled"
        | "superseded";
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly startedModes?:
        | { readonly runtimeMode: Wire13; readonly interactionMode: Wire14 }
        | undefined;
    }>;
    readonly nodes: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly parentNodeId: string | null;
      readonly rootNodeId: string;
      readonly kind:
        | "root_turn"
        | "assistant_message"
        | "reasoning"
        | "plan"
        | "todo_list"
        | "tool_call"
        | "approval_request"
        | "user_input_request"
        | "subagent"
        | "hook"
        | "system";
      readonly status:
        | "idle"
        | "pending"
        | "running"
        | "waiting"
        | "completed"
        | "interrupted"
        | "failed"
        | "cancelled"
        | "rolled_back";
      readonly countsForRun: boolean;
      readonly providerThreadId: string | null;
      readonly providerTurnId: string | null;
      readonly nativeItemRef: Wire53 | null;
      readonly runtimeRequestId: string | null;
      readonly checkpointScopeId: string | null;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    }>;
    readonly subagents: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly parentNodeId: string;
      readonly origin: "provider_native" | "app_owned";
      readonly createdBy: Wire11;
      readonly driver: string;
      readonly providerInstanceId: string;
      readonly providerThreadId: string | null;
      readonly childThreadId: string | null;
      readonly remoteChild?: Wire55;
      readonly nativeTaskRef: Wire53 | null;
      readonly prompt: string;
      readonly title: string | null;
      readonly model: string | null;
      readonly modelSelection?: Wire56;
      readonly executedModel?: Wire38;
      readonly completionWake?: "always" | "settled_only" | undefined;
      readonly completionDelivery?:
        | {
            readonly state: "pending" | "claimed" | "acknowledged" | "delivered" | "disposed";
            readonly observedByRunId: string | null;
          }
        | undefined;
      readonly cancelledRunId?: Wire9;
      readonly status:
        | "idle"
        | "pending"
        | "running"
        | "waiting"
        | "completed"
        | "failed"
        | "cancelled"
        | "interrupted";
      readonly progress?: Wire38;
      readonly workflow?:
        | {
            readonly name?: Wire9;
            readonly runHandles?:
              | {
                  readonly runId?: Wire9;
                  readonly transcriptDir?: Wire9;
                  readonly scriptPath?: Wire9;
                }
              | undefined;
            readonly phases: globalThis.ReadonlyArray<{
              readonly index: number;
              readonly title: string;
            }>;
            readonly agents: globalThis.ReadonlyArray<{
              readonly index: number;
              readonly label: string;
              readonly agentId?: Wire9;
              readonly childThreadId?: Wire9;
              readonly state: "queued" | "running" | "completed" | "failed";
              readonly phaseIndex?: Wire20;
              readonly phaseTitle?: Wire9;
              readonly model?: Wire9;
              readonly effort?: Wire9;
              readonly speed?: Wire9;
              readonly attempt?: Wire20;
              readonly totalTokens?: Wire20;
              readonly toolCalls?: Wire20;
              readonly durationMs?: Wire20;
              readonly queuedAt?: Wire20;
              readonly startedAt?: Wire20;
              readonly completedAt?: Wire20;
              readonly prompt?: Wire57;
              readonly result?: Wire57;
            }>;
            readonly totalTokens?: Wire20;
            readonly toolCalls?: Wire20;
            readonly durationMs?: Wire20;
          }
        | undefined;
      readonly result: string | null;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly updatedAt: string;
      readonly promptOmitted?: true;
      readonly resultOmitted?: true;
    }>;
    readonly providerSessions: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly driver: string;
      readonly providerInstanceId: string;
      readonly status: "starting" | "ready" | "running" | "waiting" | "stopped" | "error";
      readonly cwd: string;
      readonly model: string | null;
      readonly capabilities: {
        readonly sessions: {
          readonly supportsMultipleProviderThreadsPerSession: boolean;
          readonly supportsModelSwitchInSession: boolean;
          readonly supportsProviderSwitchingViaHandoff: boolean;
          readonly supportsRuntimeModeSwitchInSession: boolean;
          readonly pendingRequestsSurviveRestart: boolean;
        };
        readonly threads: {
          readonly canCreateEmptyThread: boolean;
          readonly canReadThreadSnapshot: boolean;
          readonly canRollbackThread: boolean;
          readonly canForkThread: boolean;
          readonly canForkFromTurn: boolean;
          readonly canForkWhileSourceRunning?: Wire7;
          readonly canForkFromSubagentThread: boolean;
          readonly exposesNativeThreadId: boolean;
        };
        readonly turns: {
          readonly supportsNativeGoals?: Wire7;
          readonly exposesNativeTurnId: boolean;
          readonly emitsTurnStarted: boolean;
          readonly emitsTurnCompleted: boolean;
          readonly supportsInterrupt: boolean;
          readonly supportsNativeResume?: Wire7;
          readonly supportsActiveSteering: boolean;
          readonly activeSteeringInterruptsTools?: Wire7;
          readonly activeSteeringAcceptsAttachments?: Wire7;
          readonly activeSteeringDuringCompaction?: Wire7;
          readonly supportsSteeringByInterruptRestart: boolean;
          readonly supportsQueuedMessages: boolean;
          readonly terminalStatusQuality: "strong" | "weak" | "none";
        };
        readonly streaming: {
          readonly streamsAssistantText: boolean;
          readonly streamsReasoning: boolean;
          readonly streamsToolOutput: boolean;
          readonly streamsPlanText: boolean;
          readonly emitsMessageCompleted: boolean;
        };
        readonly tools: {
          readonly exposesToolItemIds: boolean;
          readonly emitsToolStarted: boolean;
          readonly emitsToolCompleted: boolean;
          readonly emitsToolOutput: boolean;
          readonly supportsMcpTools: boolean;
          readonly supportsDynamicToolCallbacks: boolean;
          readonly supportsBackgroundWait?: Wire7;
        };
        readonly approvals: {
          readonly supportsCommandApproval: boolean;
          readonly supportsFileReadApproval: boolean;
          readonly supportsFileChangeApproval: boolean;
          readonly supportsApplyPatchApproval: boolean;
          readonly approvalsHaveNativeRequestIds: boolean;
          readonly approvalCallbacksAreLiveOnly: boolean;
          readonly approvalsCanOriginateFromSubagents: boolean;
        };
        readonly planning: {
          readonly emitsPlanUpdated: boolean;
          readonly emitsTodoList: boolean;
          readonly emitsProposedPlan: boolean;
          readonly supportsStructuredQuestions: boolean;
          readonly planDeltasHaveItemIds: boolean;
        };
        readonly subagents: {
          readonly supportsSubagents: boolean;
          readonly exposesSubagentThreadIds: boolean;
          readonly emitsSubagentLifecycle: boolean;
          readonly canWaitForSubagents: boolean;
          readonly canCloseSubagents: boolean;
          readonly canForkSubagentThread: boolean;
        };
        readonly context: {
          readonly acceptsSystemContext: boolean;
          readonly acceptsDeveloperContext: boolean;
          readonly acceptsSyntheticUserContext: boolean;
          readonly canGenerateSummaries: boolean;
          readonly canConsumeHandoffSummaries: boolean;
          readonly supportsDeltaHandoff: boolean;
          readonly supportsFullThreadHandoff: boolean;
          readonly maxRecommendedHandoffChars: number | null;
        };
        readonly checkpointing: {
          readonly appCanCheckpointFilesystem: boolean;
          readonly supportsNestedCheckpointScopes: boolean;
          readonly providerCanRollbackConversation: boolean;
          readonly providerRollbackReturnsSnapshot: boolean;
          readonly providerCanReadConversationSnapshot: boolean;
        };
        readonly identity: {
          readonly nativeThreadIds: Wire54;
          readonly nativeTurnIds: Wire54;
          readonly nativeItemIds: Wire54;
          readonly nativeRequestIds: Wire54;
        };
        readonly runtimePolicy?: { readonly enforcement: "native" | "client-boundary" } | undefined;
      };
      readonly extensionStatuses?:
        | globalThis.ReadonlyArray<{ readonly key: string; readonly text: string }>
        | undefined
        | undefined;
      readonly startupPhase?: string;
      readonly startupPhaseThreadId?: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly lastError: string | null;
    }>;
    readonly providerThreads: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly driver: string;
      readonly providerInstanceId: string;
      readonly providerSessionId: string | null;
      readonly appThreadId: string | null;
      readonly ownerNodeId: string | null;
      readonly nativeThreadRef: Wire53 | null;
      readonly nativeConversationHeadRef: Wire53 | null;
      readonly status: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
      readonly firstRunOrdinal: number | null;
      readonly lastRunOrdinal: number | null;
      readonly handoffIds: globalThis.ReadonlyArray<string>;
      readonly forkedFrom: {
        readonly providerThreadId: string;
        readonly providerTurnId?: Wire9;
        readonly checkpointId?: Wire9;
      } | null;
      readonly pendingBackgroundTasks?: globalThis.ReadonlyArray<Wire37> | undefined | undefined;
      readonly contextUsage?:
        | {
            readonly usedTokens: number;
            readonly totalProcessedTokens?: Wire20;
            readonly maxTokens?: Wire58;
            readonly inputTokens?: Wire20;
            readonly cachedInputTokens?: Wire20;
            readonly outputTokens?: Wire20;
            readonly reasoningOutputTokens?: Wire20;
            readonly lastUsedTokens?: Wire20;
            readonly lastInputTokens?: Wire20;
            readonly lastCachedInputTokens?: Wire20;
            readonly lastOutputTokens?: Wire20;
            readonly lastReasoningOutputTokens?: Wire20;
            readonly toolUses?: Wire20;
            readonly durationMs?: Wire20;
            readonly compactsAutomatically?: Wire7;
            readonly autoCompactThreshold?: Wire58;
            readonly cost?: { readonly amount: number; readonly currency: string } | undefined;
          }
        | null
        | undefined
        | undefined;
      readonly nativeMetadata?: Wire59 | null | undefined | undefined;
      readonly goal?: Wire40 | null | undefined | undefined;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly providerTurns: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly providerThreadId: string;
      readonly nodeId: string;
      readonly runAttemptId: string | null;
      readonly nativeTurnRef: Wire53 | null;
      readonly nativeThreadRef?: Wire60;
      readonly ordinal: number;
      readonly status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly tokenUsage?: Wire61;
      readonly turnTokenUsage?:
        | {
            readonly usageScope: "main_agent";
            readonly cachedInputTokens?: Wire20;
            readonly cacheCreationTokens?: Wire20;
            readonly reasoningTokens?: Wire20;
            readonly hasSubagents: boolean;
            readonly models?: Wire62;
            readonly localCommand?: Wire7;
            readonly otherUsage?: Wire63;
            readonly usageStatus: "complete";
            readonly inputTokens: number;
            readonly outputTokens: number;
          }
        | {
            readonly usageScope: "main_agent";
            readonly cachedInputTokens?: Wire20;
            readonly cacheCreationTokens?: Wire20;
            readonly reasoningTokens?: Wire20;
            readonly hasSubagents: boolean;
            readonly models?: Wire62;
            readonly localCommand?: Wire7;
            readonly otherUsage?: Wire63;
            readonly usageStatus: "partial" | "unavailable";
            readonly inputTokens?: Wire20;
            readonly outputTokens?: Wire20;
          }
        | undefined;
      readonly model?: Wire9;
      readonly promptDropped?: true | undefined;
    }>;
    readonly runtimeRequests: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly nodeId: string;
      readonly providerTurnId: string | null;
      readonly nativeRequestRef: Wire53 | null;
      readonly kind: Wire34;
      readonly status: "pending" | "resolved" | "expired" | "cancelled";
      readonly responseCapability:
        | {
            readonly type: "live";
            readonly providerSessionId: string;
            readonly supportsFeedback?: Wire7;
          }
        | { readonly type: "message" }
        | { readonly type: "not_resumable"; readonly reason: string };
      readonly createdAt: string;
      readonly resolvedAt: string | null;
      readonly decision?: Wire64;
      readonly feedback?: Wire38;
      readonly answers?: Wire66;
    }>;
    readonly messages: globalThis.ReadonlyArray<{
      readonly notification?: Wire68;
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly scheduledTaskId?: Wire9;
      readonly followsThreadSelection?: true | undefined;
      readonly senderThreadId?: Wire9;
      readonly linkedSender?: Wire72;
      readonly idleCompaction?: Wire73;
      readonly workflowScript?: Wire7;
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly nodeId: string | null;
      readonly role: Wire36;
      readonly text: string;
      readonly context?: Wire74;
      readonly attachments: globalThis.ReadonlyArray<Wire46>;
      readonly streaming: boolean;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly delegatedCompletion?:
        | {
            readonly parentRunId: string;
            readonly generation: number;
            readonly taskIds: globalThis.ReadonlyArray<string>;
          }
        | undefined;
    }>;
    readonly plans: globalThis.ReadonlyArray<
      | {
          readonly id: string;
          readonly threadId: string;
          readonly runId: Wire75;
          readonly nodeId: string;
          readonly status: Wire76;
          readonly detailInTurnItem?: Wire77;
          readonly kind: "proposed_plan";
          readonly markdown: string;
        }
      | {
          readonly id: string;
          readonly threadId: string;
          readonly runId: Wire75;
          readonly nodeId: string;
          readonly status: Wire76;
          readonly detailInTurnItem?: Wire77;
          readonly kind: "todo_list";
          readonly steps: globalThis.ReadonlyArray<Wire78>;
          readonly explanation?: Wire38;
        }
    >;
    readonly turnItems: globalThis.ReadonlyArray<
      | Wire79
      | Wire94
      | Wire95
      | Wire96
      | Wire97
      | Wire98
      | Wire99
      | Wire101
      | Wire102
      | Wire103
      | Wire104
      | Wire105
      | Wire106
      | Wire109
      | Wire110
      | Wire111
      | Wire112
      | Wire114
      | Wire115
      | Wire116
      | Wire117
      | Wire118
      | Wire119
      | Wire120
      | Wire122
      | Wire123
      | { readonly type: string }
    >;
    readonly checkpointScopes: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly nodeId: string;
      readonly parentScopeId: string | null;
      readonly providerThreadId: string | null;
      readonly kind: "root_run" | "subagent" | "tool" | "provider_thread" | "manual";
      readonly ordinalWithinParent: number;
      readonly advancesAppRunCount: boolean;
      readonly cwd: string;
      readonly label?: string;
      readonly repositoryPath?: string;
      readonly createdAt: string;
    }>;
    readonly checkpoints: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly scopeId: string;
      readonly runId: string | null;
      readonly nodeId: string;
      readonly parentCheckpointId: string | null;
      readonly ordinalWithinScope: number;
      readonly appRunOrdinal: number | null;
      readonly ref: string;
      readonly status: "ready" | "missing" | "error" | "stale";
      readonly files: globalThis.ReadonlyArray<Wire107>;
      readonly filesTotal?: Wire108;
      readonly capturedAt: string;
    }>;
    readonly contextHandoffs: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly transferId?: string | null | undefined;
      readonly threadId: string;
      readonly targetRunId: string;
      readonly fromProviderThreadIds: globalThis.ReadonlyArray<string>;
      readonly toProviderThreadId: string;
      readonly coveredRunOrdinals: { readonly from: number; readonly to: number };
      readonly strategy:
        | "delta_since_target_last_seen"
        | "fork_delta_summary"
        | "full_thread_summary"
        | "checkpoint_summary"
        | "manual_context";
      readonly status: "pending" | "ready" | "failed" | "superseded";
      readonly summaryMessageId: string | null;
      readonly summaryText: string;
      readonly history?:
        | {
            readonly messages: globalThis.ReadonlyArray<{
              readonly role: "user" | "assistant";
              readonly text: string;
              readonly runStatus?: Wire38;
              readonly threadId: string;
              readonly runId: string | null;
              readonly itemId: string;
              readonly providerThreadId: string | null;
              readonly status: string;
              readonly kind: string;
            }>;
            readonly coverage: string;
            readonly omittedItems: number;
            readonly omittedItemIds?: globalThis.ReadonlyArray<string> | undefined;
          }
        | undefined;
      readonly delivery?:
        | {
            readonly nativeThreadId: string;
            readonly status: "pending" | "injected" | "inline";
            readonly itemIds: globalThis.ReadonlyArray<string>;
            readonly omittedItemIds?: globalThis.ReadonlyArray<string> | undefined;
          }
        | undefined;
      readonly detailInTurnItem?: true | undefined;
      readonly createdByProviderInstanceId: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly contextTransfers: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly type:
        | "fork"
        | "provider_handoff"
        | "merge_back"
        | "subagent_spawn"
        | "subagent_result";
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire124;
      readonly basePoint: Wire124 | null;
      readonly sourceProviderInstanceId: string | null;
      readonly sourceTokenUsage?: Wire61;
      readonly targetProviderInstanceId: string | null;
      readonly targetRunId: string | null;
      readonly status:
        | "pending"
        | "resolved_native"
        | "resolved_portable"
        | "failed"
        | "consumed"
        | "superseded";
      readonly resolution:
        | { readonly strategy: "native_fork"; readonly providerThreadRef: Wire53 }
        | { readonly strategy: "portable_context"; readonly contextHandoffId: string }
        | { readonly strategy: "delta_context"; readonly contextHandoffId: string }
        | { readonly strategy: "fork_delta_context"; readonly contextHandoffId: string }
        | { readonly strategy: "checkpoint_context"; readonly contextHandoffId: string }
        | null;
      readonly createdBy: Wire11;
      readonly error: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly consumedAt: string | null;
    }>;
    readonly visibleTurnItems: globalThis.ReadonlyArray<{
      readonly position: number;
      readonly visibility: "local" | "inherited" | "synthetic";
      readonly sourceThreadId: string;
      readonly sourceItemId: string;
      readonly item:
        | Wire79
        | Wire94
        | Wire95
        | Wire96
        | Wire97
        | Wire98
        | Wire99
        | Wire101
        | Wire102
        | Wire103
        | Wire104
        | Wire105
        | Wire106
        | Wire109
        | Wire110
        | Wire111
        | Wire112
        | Wire114
        | Wire115
        | Wire116
        | Wire117
        | Wire118
        | Wire119
        | Wire120
        | Wire122
        | Wire123
        | { readonly type: string };
    }>;
    readonly updatedAt: string;
  };
};

export type OrchestrationCommand =
  | {
      readonly type: "thread.stop";
      readonly commandId: string;
      readonly threadId: string;
      readonly reason?: Wire38;
      readonly stopDelegatedTasks?: Wire7;
    }
  | {
      readonly type: "thread.create";
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly titleRenamed?: Wire7;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire13;
      readonly interactionMode: Wire14;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly linkOrigin?: Wire28;
      readonly delegatedFrom?: Wire30;
      readonly workflowRun?: Wire31;
      readonly importedNativeThread?:
        | {
            readonly ref: {
              readonly driver: string;
              readonly nativeId: string;
              readonly strength: "strong";
            };
            readonly metadata?: Wire59 | undefined;
          }
        | undefined;
      readonly initialMessage?:
        | {
            readonly messageId: string;
            readonly text: string;
            readonly attachments: globalThis.ReadonlyArray<Wire46>;
            readonly context?: Wire74;
            readonly titleSeed?: Wire9;
            readonly scheduledTaskId?: Wire9;
            readonly senderThreadId?: Wire9;
            readonly outputSchema?: { readonly [x: string]: Json } | undefined;
            readonly workspaceStrategy?: Wire51;
          }
        | undefined;
    }
  | { readonly type: "thread.archive"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "thread.guest-share.close";
      readonly commandId: string;
      readonly threadId: string;
    }
  | {
      readonly type: "thread.guest-message.dismiss";
      readonly commandId: string;
      readonly threadId: string;
      readonly guestMessageId: string;
    }
  | { readonly type: "thread.unarchive"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "thread.delete";
      readonly commandId: string;
      readonly threadId: string;
      readonly onlyIfUnused?: Wire7;
    }
  | {
      readonly type: "thread.settle";
      readonly commandId: string;
      readonly threadId: string;
      readonly expectedLatestRunId?: Wire9;
      readonly settledAt?: Wire50;
    }
  | {
      readonly type: "thread.auto-settle";
      readonly commandId: string;
      readonly threadId: string;
      readonly snapshotAt: string;
      readonly settledAt?: Wire50;
    }
  | {
      readonly type: "thread.unsettle";
      readonly commandId: string;
      readonly threadId: string;
      readonly reason: "user";
      readonly restoreUnsettledAt?: string | null | undefined;
    }
  | {
      readonly type: "thread.snooze";
      readonly commandId: string;
      readonly threadId: string;
      readonly snoozedUntil: string;
    }
  | {
      readonly type: "thread.unsnooze";
      readonly commandId: string;
      readonly threadId: string;
      readonly reason: "user";
    }
  | {
      readonly type: "thread.auto-settle.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly enabled: boolean;
    }
  | {
      readonly type: "thread.pin";
      readonly commandId: string;
      readonly threadId: string;
      readonly orderKey?: Wire9;
    }
  | { readonly type: "thread.unpin"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "thread.tag.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly tag: string;
      readonly tagged: boolean;
    }
  | {
      readonly type: "thread.pin.reorder";
      readonly commandId: string;
      readonly threadId: string;
      readonly orderKey: string;
    }
  | {
      readonly type: "thread.active.reorder";
      readonly commandId: string;
      readonly threadId: string;
      readonly orderKey: string;
    }
  | {
      readonly type: "thread.visit";
      readonly commandId: string;
      readonly threadId: string;
      readonly visitedAt: string;
      readonly opened?: Wire7;
      readonly searchQuery?: string | undefined;
    }
  | { readonly type: "thread.mark-unread"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "thread.metadata.update";
      readonly commandId: string;
      readonly threadId: string;
      readonly title?: Wire9;
      readonly regenerateTitle?: Wire7;
      readonly branch?: string | null | undefined;
      readonly worktreePath?: string | null | undefined;
      readonly expectedWorktreePath?: string | null | undefined;
      readonly expectedBranch?: string | null | undefined;
      readonly continuation?: { readonly messageId: string; readonly text: string } | undefined;
      readonly expectedEmpty?: Wire7;
      readonly limitRecovery?:
        | {
            readonly runId: string;
            readonly resetAt: string;
            readonly autoResume?: Wire7;
            readonly snooze?: Wire7;
          }
        | null
        | undefined;
      readonly linkedPullRequest?: Wire15 | null | undefined;
    }
  | {
      readonly type: "thread.pull-request.link";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly source: Wire17;
      readonly repositoryWebUrl?: Wire9;
    }
  | {
      readonly type: "thread.pull-request.unlink";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
    }
  | {
      readonly type: "thread.pull-request-link.sync";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly snapshot: Wire18;
      readonly stack: Wire21 | null;
    }
  | {
      readonly type: "thread.issue.link";
      readonly commandId: string;
      readonly threadId: string;
      readonly tracker: string;
      readonly host: string;
      readonly scope: string;
      readonly key: string;
      readonly projectId: string;
      readonly url: string;
      readonly displayKey: string;
      readonly title: string;
      readonly source: Wire24;
    }
  | {
      readonly type: "thread.issue.unlink";
      readonly commandId: string;
      readonly threadId: string;
      readonly tracker: string;
      readonly host: string;
      readonly scope: string;
      readonly key: string;
    }
  | {
      readonly type: "thread.pull-request.watch";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly watching: boolean;
      readonly until?: "checks" | "merged" | undefined;
      readonly checksPending?: Wire7;
      readonly link?:
        | { readonly url: string; readonly source: Wire17; readonly repositoryWebUrl?: Wire9 }
        | undefined;
    }
  | {
      readonly type: "thread.pull-request.sync";
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly snapshotSequence: number;
      readonly expected: {
        readonly workspaceRoot: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly linkedPullRequest: Wire15 | null;
        readonly branchPullRequest: Wire15 | null;
      };
      readonly branchPullRequest: Wire15 | null;
      readonly linkedPullRequest?: Wire15 | undefined;
    }
  | {
      readonly type: "thread.title.regeneration.complete";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly title?: Wire9;
      readonly outcome?: { readonly status: Wire45; readonly message?: Wire38 } | undefined;
    }
  | {
      readonly type: "thread.runtime-mode.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly runtimeMode: Wire13;
    }
  | {
      readonly type: "thread.interaction-mode.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly interactionMode: Wire14;
    }
  | {
      readonly type: "thread.model-selection.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly modelSelection: Wire3;
    }
  | {
      readonly type: "provider-session.detach";
      readonly commandId: string;
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly reason?: Wire38;
    }
  | {
      readonly type: "message.dispatch";
      readonly notification?: Wire68;
      readonly guestMessageId?: Wire9;
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly scheduledTaskId?: Wire9;
      readonly senderThreadId?: Wire9;
      readonly linkedSender?: Wire72;
      readonly idleCompaction?: Wire73;
      readonly freshContext?: Wire7;
      readonly outputSchema?: { readonly [x: string]: Json } | undefined;
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string;
      readonly context?: Wire74;
      readonly attachments: globalThis.ReadonlyArray<Wire46>;
      readonly titleSeed?: Wire9;
      readonly modelSelection?: Wire56;
      readonly sourcePlanRef?: { readonly threadId: string; readonly planId: string } | undefined;
      readonly restartContinuationOfRunId?: Wire9;
      readonly usageLimitContinuationOfRunId?: Wire9;
      readonly manualContinuationOfRunId?: Wire9;
      readonly steerFollowUpOfRunId?: Wire9;
      readonly steerFollowUpAfterRunOrdinal?: Wire20;
      readonly usageLimitRecoveryRequestId?: Wire9;
      readonly deliveryIntent?: "auto" | "steer" | "restart" | undefined;
      readonly explicitQueue?: true | undefined;
      readonly delegatedCompletion?:
        | {
            readonly parentRunId: string;
            readonly generation: number;
            readonly taskIds: globalThis.ReadonlyArray<string>;
          }
        | undefined;
      readonly dispatchMode:
        | { readonly type: "defer_start"; readonly workspaceStrategy?: Wire51 }
        | { readonly type: "steer_active"; readonly targetRunId: string }
        | { readonly type: "restart_active"; readonly targetRunId: string }
        | { readonly type: "queue_after_active" }
        | { readonly type: "start_immediately" };
    }
  | {
      readonly type: "prepared-run.release";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
    }
  | {
      readonly type: "notification.delivery.accept";
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "prepared-run.progress";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly phase: "worktree" | "setup";
    }
  | {
      readonly type: "prepared-run.fail";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly failure: Wire113;
    }
  | {
      readonly type: "prepared-run.retry";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
    }
  | {
      readonly type: "subagent.stop";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly subagentId: string;
    }
  | {
      readonly type: "run.interrupt";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly reason?: Wire38;
      readonly holdQueue?: Wire7;
    }
  | {
      readonly type: "queued-message.promote-to-steer";
      readonly commandId: string;
      readonly threadId: string;
      readonly queuedRunId: string;
      readonly targetRunId: string;
    }
  | { readonly type: "queue.resume"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "queued-run.start";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
    }
  | {
      readonly type: "queued-run.reorder";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly beforeRunId: string | null;
    }
  | {
      readonly type: "queued-run.cancel";
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
    }
  | {
      readonly type: "queued-run.edit";
      readonly modelSelection?: Wire56;
      readonly context?: Wire74;
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly text: string;
      readonly attachments?: globalThis.ReadonlyArray<Wire46> | undefined;
    }
  | {
      readonly type: "runtime-request.respond";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision?: Wire64;
      readonly feedback?: Wire38;
      readonly answers?: Wire66;
      readonly attachmentsByQuestionId?: Wire100 | undefined;
    }
  | {
      readonly type: "thread.user-input.dismiss";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
    }
  | {
      readonly type: "checkpoint.rollback";
      readonly restoreFiles?: Wire7;
      readonly commandId: string;
      readonly threadId: string;
      readonly scopeId: string;
      readonly checkpointId: string;
    }
  | {
      readonly type: "thread.fork";
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly commandId: string;
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire125;
      readonly title?: Wire9;
      readonly sideChat?: Wire7;
      readonly createdAt?: Wire50;
    }
  | {
      readonly type: "thread.merge_back";
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly commandId: string;
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire125;
      readonly createdAt?: Wire50;
    }
  | {
      readonly type: "delegated_task.request";
      readonly createdBy: Wire11;
      readonly creationSource: Wire12;
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly parentRunId: string;
      readonly parentNodeId: string;
      readonly task: string;
      readonly title?: Wire9;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire13;
      readonly interactionMode: Wire14;
      readonly workspaceStrategy?: Wire51;
      readonly completionWake?: "always" | "settled_only" | undefined;
      readonly createdAt?: Wire50;
    }
  | {
      readonly type: "delegated_task.wake-policy";
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly taskId: string;
      readonly completionWake: "always" | "settled_only";
    }
  | {
      readonly type: "delegated_task.completion-delivery.acknowledge";
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly taskId: string;
      readonly observedByRunId: string | null;
    }
  | {
      readonly type: "delegated_task.completion-delivery.dispose";
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly taskId: string;
    }
  | {
      readonly type: "thread.created.record";
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly parentRunId: string;
      readonly parentNodeId: string;
      readonly targetThreadId: string;
      readonly targetRunId: string | null;
    }
  | {
      readonly type: "provider.switch";
      readonly commandId: string;
      readonly threadId: string;
      readonly modelSelection: Wire3;
    };

export type DispatchResult = { readonly sequence: number };

export type ServerSettings = {
  readonly favorites?: Wire126 | null | undefined;
  readonly providerModelPreferences?: Wire127 | null | undefined;
  readonly worktreeCleanup?: Wire128 | undefined;
  readonly storageCleanup?:
    | {
        readonly worktreeKeepWhen?: Wire129;
        readonly worktreeAfterDays?: Wire134;
        readonly worktreeSettledAfterDays?: Wire132;
        readonly worktreeOnMerge?: Wire7;
        readonly worktreeOnDelete?: Wire7;
        readonly worktreeUnchanged?: Wire7;
        readonly browserArtifactsAfterDays?: Wire134;
        readonly logsAfterDays?: Wire134;
      }
    | undefined;
  readonly worktreesDirectory?: Wire38;
  readonly fastWorktreeCheckout?: Wire7;
  readonly previousWorktreesDirectories?: globalThis.ReadonlyArray<string> | undefined;
  readonly responseStreamingMode?: Wire135 | undefined;
  readonly agentFeedback?: { readonly mode?: Wire136 } | undefined;
  readonly enableProviderUpdateChecks?: Wire7;
  readonly continueThreadsAfterServerUpdate?: Wire7;
  readonly keepAwakeWhileAgentsWork?: Wire7;
  readonly requireConnectDeviceApproval?: Wire7;
  readonly enableAgentBrowserAccess?: Wire7;
  readonly enablePreviewTunnel?: Wire7;
  readonly cloudSpeechCredentials?:
    | { readonly openai?: Wire137; readonly xai?: Wire137; readonly openrouter?: Wire137 }
    | undefined;
  readonly speechModelId?: Wire38;
  readonly speechAcceleration?: Wire140 | undefined;
  readonly speechModelUnloadTimeout?: Wire141 | undefined;
  readonly speechProjectCustomWords?: Wire142 | undefined;
  readonly speechPostProcessingModelSelection?: Wire3 | null | undefined;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultAutoPull?: Wire7;
  readonly defaultProjectScripts?: globalThis.ReadonlyArray<Wire8> | undefined;
  readonly projectScriptOverrides?:
    | { readonly [x: string]: globalThis.ReadonlyArray<Wire8> | null }
    | undefined;
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultModelSelection?: Wire3 | null | undefined;
  readonly fallbackModelSelection?: Wire3 | null | undefined;
  readonly defaultRuntimeMode?: Wire13 | undefined;
  readonly projectSettingsOverrides?:
    | {
        readonly [x: string]: {
          readonly worktreeCleanup?: Wire128;
          readonly defaultModelSelection?: Wire143;
          readonly defaultRuntimeMode?: Wire13;
          readonly defaultThreadEnvMode?: Wire6;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire144;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire145;
          readonly reviewGuideModelSelection?: Wire146;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire147;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire150;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire151;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire153;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire135;
          readonly speechProjectCustomWords?: Wire142;
          readonly providerInstances?: Wire154;
        } & { readonly [x: string]: unknown };
      }
    | undefined;
  readonly projectSettingsFolded?: Wire7;
  readonly enableAgentDeviceAccess?: Wire7;
  readonly enableDeviceSupport?: Wire7;
  readonly deviceOnboardingCompleted?: Wire7;
  readonly deviceHosts?: Wire155 | undefined;
  readonly easDeviceHosts?: Wire156 | undefined;
  readonly simlockDeviceHosts?: Wire157 | undefined;
  readonly simlockDeviceHostsEnabled?: Wire7;
  readonly sidebarAutoSettleAfterDays?: number | null | undefined;
  readonly compactIdleThreads?: Wire158 | undefined;
  readonly idleCompaction?: Wire159;
  readonly snoozeLimitedThreads?: Wire7;
  readonly autoResumeLimitedThreads?: Wire7;
  readonly snoozePresets?: globalThis.ReadonlyArray<Wire160> | undefined;
  readonly hiddenThreadTags?: globalThis.ReadonlyArray<unknown> | undefined;
  readonly hideTaggedThreads?: Wire7;
  readonly guestSharingEnabled?: Wire7;
  readonly linkedEnvironmentsEnabled?: Wire7;
  readonly workflowsEnabled?: Wire7;
  readonly workflowSkippedRunsKept?: number | undefined;
  readonly promptSuggestionsEnabled?: Wire7;
  readonly sidebarAutoSettleKeepPullRequests?: Wire7;
  readonly sidebarAutoSettleOnMerge?: Wire7;
  readonly backgroundActivity?:
    | {
        readonly schemaVersion?: 1 | undefined;
        readonly profile?: Wire161 | undefined;
        readonly baseProfile?: Wire162;
        readonly overrides?: Wire163 | undefined;
      }
    | undefined;
  readonly automaticGitFetchInterval?: Wire164;
  readonly providerHealthRefreshInterval?: Wire164;
  readonly backgroundActivityProfile?: Wire162 | undefined;
  readonly defaultTheme?: string | undefined;
  readonly defaultThemeSetAt?: string | undefined;
  readonly defaultAppearance?: Wire165 | undefined;
  readonly defaultAppearanceSetAt?: string | undefined;
  readonly environmentIcon?: Wire4;
  readonly defaultThreadEnvMode?: unknown;
  readonly newWorktreesStartFromOrigin?: Wire7;
  readonly worktreeSubmodules?: Wire4;
  readonly addProjectBaseDirectory?: Wire38;
  readonly ghqCloneLayout?: Wire7;
  readonly textGenerationModelSelection?: Wire3 | undefined;
  readonly threadTitleInstructions?: Wire38;
  readonly branchNamingMode?: Wire150 | undefined;
  readonly branchNamePrefix?: Wire38;
  readonly branchNameInstructions?: Wire38;
  readonly removeAgentCreditsOnMerge?: Wire7;
  readonly sourceControlWritingStyle?: Wire147 | undefined;
  readonly sourceControlWriterModelSelection?: Wire3 | null | undefined;
  readonly reviewGuidesEnabled?: Wire7;
  readonly reviewGuideModelSelection?: Wire3 | null | undefined;
  readonly reviewGuideInstructions?: Wire38;
  readonly pullRequestMergeMethod?: Wire152 | null | undefined;
  readonly providerInstances?: { readonly [x: string]: Wire166 } | undefined;
  readonly observability?:
    | {
        readonly otlpTracesUrl?: Wire38;
        readonly otlpMetricsUrl?: Wire38;
        readonly otlpLogsUrl?: Wire38;
      }
    | undefined;
  readonly sourceControlHosts?: { readonly [x: string]: Wire167 } | undefined;
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean } | undefined;
  readonly usageLimitSources?: { readonly [x: string]: Wire168 } | undefined;
  readonly textGenerators?: { readonly [x: string]: Wire169 } | undefined;
  readonly secretProviders?:
    | {
        readonly [x: string]: {
          readonly kind: string;
          readonly label: string;
          readonly config?: unknown;
        };
      }
    | undefined;
  readonly usageHistoryRetentionDays?: Wire170 | undefined;
  readonly usagePriceOverrides?: { readonly [x: string]: Wire171 } | undefined;
  readonly usageModelAliases?: { readonly [x: string]: string } | undefined;
  readonly usageModelFilter?: unknown;
};

export type ServerSettingsPatch = {
  readonly setModelFavorites?: globalThis.ReadonlyArray<{
    readonly provider: string;
    readonly model: string;
    readonly favorite: boolean;
  }>;
  readonly setModelsHidden?: globalThis.ReadonlyArray<{
    readonly provider: string;
    readonly model: string;
    readonly hidden: boolean;
  }>;
  readonly setProviderModelOrder?: {
    readonly provider: string;
    readonly modelOrder: globalThis.ReadonlyArray<string>;
  };
  readonly favorites?: Wire126;
  readonly providerModelPreferences?: Wire127;
  readonly migrateModelPreferences?: {
    readonly favorites?: Wire126;
    readonly providerModelPreferences?: Wire127;
  };
  readonly worktreeCleanup?:
    | { readonly mode: "off" }
    | {
        readonly mode: "custom";
        readonly rules: {
          readonly worktreeKeepWhen?: Wire130;
          readonly worktreeAfterDays?: Wire131;
          readonly worktreeSettledAfterDays?: Wire133;
          readonly worktreeOnMerge?: boolean;
          readonly worktreeOnDelete?: boolean;
          readonly worktreeUnchanged?: boolean;
        };
      }
    | null;
  readonly storageCleanup?: {
    readonly worktreeKeepWhen?: Wire130;
    readonly worktreeAfterDays?: Wire131;
    readonly worktreeSettledAfterDays?: Wire133;
    readonly worktreeOnMerge?: boolean;
    readonly worktreeOnDelete?: boolean;
    readonly worktreeUnchanged?: boolean;
    readonly browserArtifactsAfterDays?: Wire131;
    readonly logsAfterDays?: Wire131;
  };
  readonly worktreesDirectory?: string;
  readonly fastWorktreeCheckout?: boolean;
  readonly responseStreamingMode?: Wire135;
  readonly agentFeedback?: { readonly mode: Wire136 };
  readonly enableProviderUpdateChecks?: boolean;
  readonly continueThreadsAfterServerUpdate?: boolean;
  readonly keepAwakeWhileAgentsWork?: boolean;
  readonly requireConnectDeviceApproval?: boolean;
  readonly enableAgentBrowserAccess?: boolean;
  readonly enablePreviewTunnel?: boolean;
  readonly cloudSpeechCredentials?: {
    readonly openai?: Wire138;
    readonly xai?: Wire138;
    readonly openrouter?: Wire138;
  };
  readonly speechModelId?: string;
  readonly speechAcceleration?: Wire140;
  readonly speechModelUnloadTimeout?: Wire141;
  readonly speechProjectCustomWords?: Wire172;
  readonly speechPostProcessingModelSelection?: Wire3 | null;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultAutoPull?: boolean;
  readonly defaultProjectScripts?: globalThis.ReadonlyArray<Wire8>;
  readonly projectScriptOverrides?: {
    readonly [x: string]: globalThis.ReadonlyArray<Wire8> | null;
  };
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultModelSelection?: Wire3 | null;
  readonly defaultRuntimeMode?: Wire13;
  readonly fallbackModelSelection?: Wire3 | null;
  readonly projectSettingsOverrides?: {
    readonly [x: string]:
      | ({
          readonly worktreeCleanup?: Wire128;
          readonly defaultModelSelection?: Wire143;
          readonly defaultRuntimeMode?: Wire13;
          readonly defaultThreadEnvMode?: Wire6;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire144;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire145;
          readonly reviewGuideModelSelection?: Wire146;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire148;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire150;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire151;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire153;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire135;
          readonly speechProjectCustomWords?: Wire172;
          readonly providerInstances?: Wire154;
        } & { readonly [x: string]: unknown })
      | null;
  };
  readonly enableAgentDeviceAccess?: boolean;
  readonly enableDeviceSupport?: boolean;
  readonly deviceOnboardingCompleted?: boolean;
  readonly deviceHosts?: Wire155;
  readonly easDeviceHosts?: Wire156;
  readonly simlockDeviceHosts?: Wire157;
  readonly simlockDeviceHostsEnabled?: boolean;
  readonly sidebarAutoSettleAfterDays?: number | null;
  readonly compactIdleThreads?: Wire158;
  readonly idleCompaction?: Wire159;
  readonly sidebarAutoSettleKeepPullRequests?: boolean;
  readonly sidebarAutoSettleOnMerge?: boolean;
  readonly autoResumeLimitedThreads?: boolean;
  readonly snoozeLimitedThreads?: boolean;
  readonly snoozePresets?: globalThis.ReadonlyArray<Wire160>;
  readonly hiddenThreadTags?: globalThis.ReadonlyArray<string>;
  readonly hideTaggedThreads?: boolean;
  readonly guestSharingEnabled?: boolean;
  readonly linkedEnvironmentsEnabled?: boolean;
  readonly workflowsEnabled?: boolean;
  readonly workflowSkippedRunsKept?: number;
  readonly promptSuggestionsEnabled?: boolean;
  readonly backgroundActivity?: {
    readonly schemaVersion?: 1;
    readonly profile?: Wire161;
    readonly baseProfile?: Wire162;
    readonly overrides?: Wire163;
  };
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly backgroundActivityProfile?: Wire162;
  readonly defaultTheme?: string;
  readonly defaultThemeSetAt?: string;
  readonly defaultAppearance?: Wire165;
  readonly defaultAppearanceSetAt?: string;
  readonly environmentIcon?:
    | "server"
    | "cloud"
    | "linux"
    | "desktop"
    | "laptop"
    | "mac-mini"
    | "mac-studio"
    | null;
  readonly defaultThreadEnvMode?: Wire6 | null;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly worktreeSubmodules?: "recursive" | "top-level" | "none" | null;
  readonly addProjectBaseDirectory?: string;
  readonly ghqCloneLayout?: boolean;
  readonly textGenerationModelSelection?: {
    readonly instanceId?: string;
    readonly model?: string;
    readonly options?: Wire5;
  };
  readonly threadTitleInstructions?: string;
  readonly branchNamingMode?: Wire150;
  readonly branchNamePrefix?: string;
  readonly branchNameInstructions?: string;
  readonly removeAgentCreditsOnMerge?: boolean;
  readonly sourceControlWritingStyle?: {
    readonly mode?: Wire149;
    readonly customInstructions?: string;
    readonly followChangeRequestTemplates?: boolean;
  };
  readonly sourceControlWriterModelSelection?: Wire3 | null;
  readonly reviewGuidesEnabled?: boolean;
  readonly reviewGuideModelSelection?: Wire3 | null;
  readonly reviewGuideInstructions?: string;
  readonly pullRequestMergeMethod?: Wire152 | null;
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
  readonly sourceControlHosts?: { readonly [x: string]: Wire167 };
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean };
  readonly providerInstances?: { readonly [x: string]: Wire166 };
  readonly usageLimitSources?: { readonly [x: string]: Wire168 | null };
  readonly textGenerators?: { readonly [x: string]: Wire169 | null };
  readonly secretProviders?: {
    readonly [x: string]: {
      readonly kind: string;
      readonly label: string;
      readonly config?: unknown;
    } | null;
  };
  readonly usageHistoryRetentionDays?: Wire170;
  readonly usagePriceOverrides?: { readonly [x: string]: Wire171 | null };
  readonly usageModelAliases?: { readonly [x: string]: string | null };
};
