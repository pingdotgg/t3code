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

export type Wire3 = {
  readonly provider?: Wire4;
  readonly instanceId?: Wire4;
  readonly model: unknown;
  readonly options?: Wire4;
};

export type Wire5 = "local" | "worktree";

export type Wire6 = boolean | undefined;

export type Wire8 = string | undefined;

export type Wire7 = {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly icon: "play" | "test" | "lint" | "configure" | "build" | "debug";
  readonly runOnWorktreeCreate: boolean;
  readonly runOnSettle?: Wire6;
  readonly stopOnSettle?: Wire6;
  readonly async?: Wire6;
  readonly previewUrl?: Wire8;
  readonly autoOpenPreview?: Wire6;
};

export type Wire10 = "user" | "agent" | "system";

export type Wire11 = "web" | "mobile" | "mcp" | "provider" | "server";

export type Wire12 = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export type Wire13 = "default" | "plan";

export type Wire14 = {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
};

export type Wire16 = "manual" | "created" | "agent" | "stack" | "stack-dismissed";

export type Wire18 = "open" | "closed" | "merged";

export type Wire19 = number | undefined;

export type Wire17 = {
  readonly state: Wire18;
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
        readonly isBot?: Wire6;
        readonly login: string;
        readonly name: string | null;
        readonly avatarUrl: string | null;
      }
    | null
    | undefined;
  readonly additions?: Wire19;
  readonly deletions?: Wire19;
  readonly changedFiles?: Wire19;
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required" | null | undefined;
  readonly checksState?: "passing" | "failing" | "pending" | null | undefined;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown" | undefined;
  readonly rebaseRequired?: Wire6;
};

export type Wire20 = {
  readonly kind: "native";
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: globalThis.ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly state: Wire18;
  }>;
};

export type Wire21 =
  | {
      readonly startedAt: string;
      readonly headSha: string | null;
      readonly failedChecks: globalThis.ReadonlyArray<string>;
      readonly passed: boolean;
      readonly passedChecks?: globalThis.ReadonlyArray<string> | undefined;
      readonly owedChecks?: globalThis.ReadonlyArray<string> | undefined;
      readonly awaitingApproval?: globalThis.ReadonlyArray<string> | undefined;
      readonly approvalAnnounced?: Wire6;
      readonly remarksThrough: string;
      readonly remarkIds: globalThis.ReadonlyArray<string>;
      readonly conflicting: boolean;
      readonly rebaseRequired?: Wire6;
      readonly mergeQueueRemovalId?: string | null | undefined;
      readonly wakes: number;
      readonly awaitingBaseline?: "all" | "checks" | undefined;
      readonly checksAwaitedSince?: string | null | undefined;
      readonly checksPending?: Wire6;
      readonly until?: "merged" | undefined;
    }
  | undefined;

export type Wire15 = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly repositoryWebUrl?: Wire8;
  readonly source: Wire16;
  readonly linkedAt: string;
  readonly snapshot: Wire17 | null;
  readonly stack: Wire20 | null;
  readonly watch?: Wire21;
  readonly endedWatch?: Wire21;
};

export type Wire23 = "manual" | "agent";

export type Wire22 = {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly projectId: string;
  readonly url: string;
  readonly source: Wire23;
  readonly linkedAt: string;
  readonly displayKey: string;
  readonly title: string;
};

export type Wire24 = {
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly rootThreadId: string;
  readonly sideChat?: Wire6;
  readonly workflowStep?: Wire6;
};

export type Wire25 =
  | { readonly type: "run"; readonly threadId: string; readonly runId: string }
  | { readonly type: "node"; readonly nodeId: string }
  | {
      readonly type: "provider_thread";
      readonly providerThreadId: string;
      readonly providerTurnId?: Wire8;
    }
  | null;

export type Wire26 = "native" | "v1_import" | undefined;

export type Wire28 =
  | "read-only"
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access"
  | undefined;

export type Wire27 =
  | { readonly sessionId: string; readonly label: string; readonly access?: Wire28 }
  | undefined;

export type Wire29 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;

export type Wire30 =
  | {
      readonly environmentId: string;
      readonly runId: string;
      readonly workflow: string;
      readonly step: string;
    }
  | undefined;

export type Wire31 =
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

export type Wire32 =
  | "usage_limit"
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

export type Wire34 = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";

export type Wire33 = Wire34 | "dynamic_tool_call" | "user_input" | "auth_refresh";

export type Wire35 = "user" | "assistant" | "system";

export type Wire37 = string | undefined;

export type Wire38 = true | undefined;

export type Wire36 =
  | {
      readonly command?: Wire37;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly runId?: Wire8;
      readonly awaited?: Wire38;
      readonly kind: "subagent";
      readonly providerInstanceId?: string | undefined;
      readonly childThreadId?: Wire8;
    }
  | {
      readonly command?: Wire37;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly runId?: Wire8;
      readonly awaited?: Wire38;
      readonly kind: "command";
    }
  | {
      readonly command?: Wire37;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly runId?: Wire8;
      readonly awaited?: Wire38;
      readonly kind: "monitor";
    }
  | {
      readonly command?: Wire37;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly runId?: Wire8;
      readonly awaited?: Wire38;
      readonly kind: "background_task";
    }
  | {
      readonly command?: Wire37;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly runId?: Wire8;
      readonly awaited?: Wire38;
      readonly kind?: string | undefined;
    };

export type Wire39 = {
  readonly objective: string;
  readonly status:
    | "active"
    | "paused"
    | "blocked"
    | "usage_limited"
    | "budget_limited"
    | "complete";
  readonly tokensUsed?: Wire19;
  readonly tokenBudget?: number | null | undefined;
  readonly timeUsedSeconds?: Wire19;
  readonly checks?: Wire19;
  readonly lastCheck?: Wire37;
};

export type Wire40 = {
  readonly requestId?: Wire8;
  readonly runId: string;
  readonly resetAt: string;
  readonly autoResume: boolean;
  readonly snooze?: Wire6;
};

export type Wire41 = globalThis.ReadonlyArray<string> | undefined;

export type Wire42 =
  | {
      readonly openedAt: number;
      readonly score: number;
      readonly picks: globalThis.ReadonlyArray<{ readonly query: string; readonly at: number }>;
    }
  | null
  | undefined;

export type Wire44 = "renamed" | "unchanged" | "failed";

export type Wire43 = {
  readonly status: Wire44;
  readonly message?: Wire37;
  readonly requestId: string;
  readonly completedAt: string;
};

export type Wire9 = {
  readonly createdBy: Wire10;
  readonly creationSource: Wire11;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelSelection: Wire3;
  readonly runtimeMode: Wire12;
  readonly interactionMode: Wire13;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly linkedPullRequest?: Wire14 | null | undefined;
  readonly pullRequests?: globalThis.ReadonlyArray<Wire15> | undefined;
  readonly branchPullRequest?: Wire14 | null | undefined;
  readonly issues?: globalThis.ReadonlyArray<Wire22> | undefined;
  readonly lineage: Wire24;
  readonly forkedFrom: Wire25 | null;
  readonly activeProviderThreadId: string | null;
  readonly historyOrigin?: Wire26;
  readonly linkOrigin?: Wire27;
  readonly delegatedFrom?: Wire29;
  readonly workflowRun?: Wire30;
  readonly latestRunId: string | null;
  readonly latestRunRequestedAt?: string | null | undefined;
  readonly latestRunStartedAt?: string | null | undefined;
  readonly latestRunCompletedAt?: string | null | undefined;
  readonly latestRunStopRequested?: Wire6;
  readonly latestRunBackgroundWake?: Wire6;
  readonly activeRunId: string | null;
  readonly activityRunStartedAt?: string | null | undefined;
  readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null | undefined;
  readonly blockedOnThreadWait?: Wire6;
  readonly status: "idle" | Wire31;
  readonly lastError?: string | null | undefined;
  readonly lastErrorClass?: Wire32 | null | undefined;
  readonly lastErrorCode?: string | null | undefined;
  readonly usageLimitResetAt?: string | null | undefined;
  readonly pendingRuntimeRequest: {
    readonly id: string;
    readonly kind: Wire33;
    readonly createdAt: string;
    readonly blocking?: Wire6;
    readonly userOnly?: Wire6;
  } | null;
  readonly pendingGuestMessageCount?: Wire19;
  readonly latestVisibleMessage: {
    readonly id: string;
    readonly role: Wire35;
    readonly text: string;
    readonly updatedAt: string;
  } | null;
  readonly latestUserMessageAt: string | null;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks?: globalThis.ReadonlyArray<Wire36> | undefined | undefined;
  readonly providerInstanceHistory?: globalThis.ReadonlyArray<string> | undefined | undefined;
  readonly goal?: Wire39 | null | undefined;
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
  readonly limitRecovery?: Wire40 | null | undefined;
  readonly pinnedAt?: string | null | undefined;
  readonly autoSettleDisabledAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
  readonly tags?: Wire41;
  readonly lastVisitedAt?: string | null | undefined;
  readonly opens?: Wire42;
  readonly titleRegeneration?:
    | { readonly requestId: string; readonly startedAt: string }
    | null
    | undefined;
  readonly lastTitleRegeneration?: Wire43 | null | undefined;
  readonly deletedAt: string | null;
};

export type Wire47 = {
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
    readonly active?: Wire6;
    readonly busy?: Wire6;
    readonly checked?: "on" | "off" | "mixed" | undefined;
    readonly editable?: Wire6;
    readonly enabled?: Wire6;
    readonly expanded?: Wire6;
    readonly focused?: Wire6;
    readonly selected?: Wire6;
    readonly visible?: Wire6;
  };
  readonly actions?: globalThis.ReadonlyArray<string>;
  readonly children: globalThis.ReadonlyArray<Wire47>;
};

export type Wire46 = {
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
              readonly root: Wire47;
            }
          | undefined;
        readonly appIdentifier?: string | undefined;
        readonly appIconDataUrl?: string | undefined;
      }
    | undefined;
};

export type Wire48 = {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: { readonly _tag: "pasted-text" } | undefined;
};

export type Wire45 =
  | Wire46
  | Wire48
  | {
      readonly type: string;
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    };

export type Wire49 = string | undefined;

export type Wire51 = string | undefined;

export type Wire50 =
  | { readonly type: "root"; readonly branch?: Wire51 }
  | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch?: Wire51 }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: Wire51;
      readonly startFromOrigin?: Wire6;
      readonly repositories?: globalThis.ReadonlyArray<{ readonly path: string }> | undefined;
    }
  | undefined;

export type Wire53 = "strong" | "weak" | "none";

export type Wire52 = {
  readonly driver: string;
  readonly nativeId: string | null;
  readonly strength: Wire53;
  readonly fingerprint?: Wire8;
  readonly ordinal?: Wire19;
};

export type Wire54 =
  | {
      readonly environmentId: string;
      readonly threadId: string;
      readonly label: string;
      readonly title?: Wire37;
      readonly runId?: Wire8;
      readonly stoppedThere?: Wire6;
      readonly stopCount?: Wire19;
    }
  | undefined;

export type Wire55 = Wire3 | undefined;

export type Wire56 = string | undefined;

export type Wire57 = number | undefined;

export type Wire58 = {
  readonly cursorStoreCwd?: Wire8;
  readonly modelSelection?: Wire55;
  readonly title?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly itemIdentityVersion?: 2 | undefined;
  readonly forkHeadMessageId?: Wire8;
  readonly claudeAttachmentBudget?:
    | { readonly bytesUsed: number; readonly pagesUsed: number }
    | undefined;
};

export type Wire59 = Wire52 | undefined;

export type Wire60 =
  | {
      readonly usedTokens: number;
      readonly maxTokens?: number | null | undefined;
      readonly inputTokens?: Wire19;
      readonly cachedInputTokens?: Wire19;
      readonly outputTokens?: Wire19;
      readonly reasoningOutputTokens?: Wire19;
      readonly promptCacheTtlMs?: Wire57;
      readonly autoCompactThreshold?: Wire57;
      readonly promptCacheExpiresAt?: Wire37;
      readonly updatedAt: string;
    }
  | undefined;

export type Wire61 = globalThis.ReadonlyArray<string> | undefined;

export type Wire62 = { readonly inputTokens: number; readonly outputTokens: number } | undefined;

export type Wire64 = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export type Wire63 = Wire64 | undefined;

export type Wire66 = { readonly [x: string]: unknown };

export type Wire65 = Wire66 | undefined;

export type Wire70 = "completed" | "failed" | "cancelled" | "updated" | "unknown";

export type Wire69 = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly watchStartedAt: string;
  readonly headSha: string | null;
  readonly watchEnded?: Wire6;
  readonly section?:
    | { readonly text: string; readonly outcome: Wire70; readonly summary: string }
    | undefined;
};

export type Wire68 =
  | {
      readonly kind: "delegated_task";
      readonly taskIds: globalThis.ReadonlyArray<string>;
      readonly childThreadId?: Wire8;
    }
  | { readonly kind: "background_task"; readonly work: "subagent"; readonly childThreadId?: Wire8 }
  | { readonly kind: "background_command" }
  | { readonly kind: "subagent"; readonly childThreadId?: Wire8 }
  | { readonly kind: "command" }
  | {
      readonly kind: "monitor";
      readonly pullRequest?: Wire69 | undefined;
      readonly otherPullRequests?: globalThis.ReadonlyArray<Wire69> | undefined;
    }
  | { readonly kind: "background_task" }
  | { readonly kind: "system" }
  | { readonly kind?: string | undefined };

export type Wire67 =
  | {
      readonly source: Wire68;
      readonly outcome: Wire70;
      readonly summary: string;
      readonly detail?: Wire37;
    }
  | undefined;

export type Wire71 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;

export type Wire72 = "beforeCacheExpires" | "onReturn" | undefined;

export type Wire73 =
  | {
      readonly version: 1;
      readonly guest?:
        | {
            readonly guestMessageId: string;
            readonly name: string;
            readonly text: string;
            readonly shareId?: Wire8;
          }
        | undefined;
      readonly records: globalThis.ReadonlyArray<unknown>;
    }
  | undefined;

export type Wire74 = string | null;

export type Wire75 = "draft" | "active" | "completed" | "superseded";

export type Wire76 = true | undefined;

export type Wire77 = {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
  readonly durationAnchorAt?: Wire37;
  readonly durationMs?: Wire19;
};

export type Wire79 = {
  readonly cursor: string;
  readonly itemCount: number;
  readonly lastOrdinal: number;
};

export type Wire80 = "browser" | "computer" | undefined;

export type Wire81 =
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

export type Wire82 =
  | {
      readonly key: string;
      readonly name: string;
      readonly kind: "browser" | "computer" | "integration";
      readonly icon?: Wire81;
    }
  | undefined;

export type Wire83 = string | null;

export type Wire84 = string | null;

export type Wire85 = string | null;

export type Wire86 = string | null;

export type Wire87 = Wire52 | null;

export type Wire88 = string | null;

export type Wire89 =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Wire90 = string | null;

export type Wire91 = string | null;

export type Wire92 = string | null;

export type Wire78 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "notification";
  readonly source: Wire68;
  readonly outcome: Wire70;
  readonly summary: string;
  readonly detail?: Wire37;
};

export type Wire93 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly createdBy: Wire10;
  readonly creationSource: Wire11;
  readonly type: "user_message";
  readonly messageId: string;
  readonly scheduledTaskId?: Wire8;
  readonly senderThreadId?: Wire8;
  readonly linkedSender?: Wire71;
  readonly idleCompaction?: Wire72;
  readonly workflowScript?: Wire6;
  readonly freshContext?: Wire6;
  readonly inputIntent: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
  readonly text: string;
  readonly textOmitted?: true;
  readonly context?: Wire73;
  readonly attachments: globalThis.ReadonlyArray<Wire45>;
  readonly modelSwitch?: { readonly from: Wire3; readonly to: Wire3 } | undefined;
};

export type Wire94 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "assistant_message";
  readonly phase?: "commentary" | "partial_answer" | "final_answer" | undefined;
  readonly delivery?: "async" | undefined;
  readonly messageId: string;
  readonly text: string;
  readonly textOmitted?: true;
  readonly attachments?: globalThis.ReadonlyArray<Wire45> | undefined;
  readonly streaming: boolean;
};

export type Wire95 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "reasoning";
  readonly text: string;
  readonly streaming: boolean;
};

export type Wire96 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "proposed_plan";
  readonly planId: string;
  readonly markdown: string;
  readonly streaming: boolean;
};

export type Wire97 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "todo_list";
  readonly planId: string;
  readonly steps: globalThis.ReadonlyArray<Wire77>;
  readonly explanation?: Wire37;
};

export type Wire99 = { readonly [x: string]: globalThis.ReadonlyArray<Wire46 | Wire48> };

export type Wire98 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
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
      readonly value?: Wire37;
      readonly preview?: Wire37;
    }>;
    readonly multiSelect?: Wire6;
    readonly allowCustomAnswer?: Wire6;
    readonly initialAnswer?: Wire37;
    readonly required?: Wire6;
  }>;
  readonly questionAnswer?:
    | {
        readonly requestId: string;
        readonly questionTextById?: { readonly [x: string]: string } | undefined;
        readonly answers: Wire66;
        readonly attachmentsByQuestionId: Wire99;
      }
    | undefined;
  readonly responseMode?: "message" | undefined;
};

export type Wire100 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "file_change";
  readonly fileName: string;
  readonly additions?: Wire19;
  readonly deletions?: Wire19;
  readonly diffStr?: Wire37;
  readonly oldStr?: Wire37;
  readonly newStr?: Wire37;
  readonly changes?:
    | globalThis.ReadonlyArray<{
        readonly operation: string;
        readonly path: string;
        readonly oldPath?: Wire8;
        readonly fileType?: Wire8;
        readonly mimeType?: Wire8;
      }>
    | undefined;
};

export type Wire101 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "command_execution";
  readonly input: string;
  readonly output?: Wire37;
  readonly outputOmitted?: Wire6;
  readonly outputIndicatesFailure?: Wire6;
  readonly exitCode?: number | undefined;
  readonly monitor?: Wire6;
  readonly completionWake?: "always" | undefined;
};

export type Wire102 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "file_search";
  readonly pattern?: Wire37;
  readonly results?:
    | globalThis.ReadonlyArray<{
        readonly fileName: string;
        readonly line?: Wire57;
        readonly column?: Wire57;
        readonly preview?: Wire37;
      }>
    | undefined;
};

export type Wire103 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "web_search";
  readonly patterns?: globalThis.ReadonlyArray<string> | undefined;
  readonly results?:
    | globalThis.ReadonlyArray<{
        readonly title?: Wire37;
        readonly url?: Wire8;
        readonly snippet?: Wire37;
      }>
    | undefined;
};

export type Wire104 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "approval_request";
  readonly requestId: string;
  readonly requestKind: Wire34;
  readonly prompt?: Wire37;
  readonly reason?: Wire37;
  readonly fullAccessOverride?: "ask_rule" | "provider_check" | undefined;
  readonly appName?: Wire37;
  readonly options?:
    | globalThis.ReadonlyArray<{
        readonly decision: Wire64;
        readonly label: string;
        readonly warning?: Wire8;
      }>
    | undefined;
};

export type Wire106 = {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
};

export type Wire107 = {
  readonly count: number;
  readonly additions: number;
  readonly deletions: number;
};

export type Wire105 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "checkpoint";
  readonly checkpointId: string;
  readonly scopeId: string;
  readonly files: globalThis.ReadonlyArray<Wire106>;
  readonly filesTotal?: Wire107;
  readonly filesOmitted?: true;
};

export type Wire108 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "run_interrupt_request";
  readonly message: string;
  readonly unresponsiveAt?: string;
};

export type Wire109 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "run_interrupt_result";
  readonly message: string;
};

export type Wire110 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "system_notice";
  readonly message: string;
  readonly level?: "info" | "warning" | "error" | undefined;
  readonly mcpSignIn?: { readonly server: string } | undefined;
};

export type Wire112 = {
  readonly class: Wire32;
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean | null;
  readonly resetAt?: string | null | undefined;
};

export type Wire111 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "error";
  readonly failure: Wire112;
  readonly retry?:
    | {
        readonly attempt: number;
        readonly maxAttempts: number | null;
        readonly retryDelayMs: number | null;
      }
    | undefined;
};

export type Wire113 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "compaction";
  readonly driver: string | null;
  readonly summary?: Wire37;
  readonly beforeTokenCount?: Wire19;
  readonly afterTokenCount?: Wire19;
};

export type Wire114 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "handoff";
  readonly contextHandoffId: string;
  readonly fromProviderThreadIds: globalThis.ReadonlyArray<string>;
  readonly toProviderThreadId: string;
  readonly fromProviderInstanceIds: globalThis.ReadonlyArray<string>;
  readonly toProviderInstanceId: string;
  readonly fromModelSelections?: globalThis.ReadonlyArray<Wire3> | undefined;
  readonly toModel?: Wire37;
  readonly strategy:
    | "delta_since_target_last_seen"
    | "fork_delta_summary"
    | "full_thread_summary"
    | "checkpoint_summary"
    | "manual_context";
  readonly summary?: Wire37;
};

export type Wire115 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId?: Wire8;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "fork";
  readonly source:
    | { readonly type: "run"; readonly threadId: string; readonly runId: string }
    | { readonly type: "node"; readonly nodeId: string }
    | {
        readonly type: "provider_thread";
        readonly providerThreadId: string;
        readonly providerTurnId?: Wire8;
      };
  readonly targetThreadId: string;
};

export type Wire116 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "thread_created";
  readonly targetThreadId: string;
  readonly targetRunId: string | null;
  readonly targetProviderInstanceId: string;
  readonly targetModel: string;
};

export type Wire117 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "secret_request";
  readonly label: string;
  readonly reason: string;
  readonly url?: Wire37;
  readonly placeholder?: Wire37;
  readonly delivery?: "file" | undefined;
  readonly fields?:
    | globalThis.ReadonlyArray<{
        readonly name: string;
        readonly label: string;
        readonly placeholder?: Wire37;
        readonly secret?: Wire6;
      }>
    | undefined;
  readonly secretStatus: "pending" | "saved" | "declined" | "cancelled";
};

export type Wire118 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "link_request";
  readonly url?: Wire8;
  readonly reason: string;
  readonly environmentId?: Wire8;
  readonly label?: Wire37;
  readonly hint?: Wire37;
  readonly requestedAccess?: Wire28;
  readonly linkStatus: "pending" | "linked" | "declined" | "cancelled" | "failed";
  readonly linkedEnvironmentId?: Wire8;
  readonly linkedLabel?: Wire37;
  readonly linkedAccess?: Wire28;
  readonly failure?: Wire37;
};

export type Wire120 = {
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

export type Wire119 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "feedback_request";
  readonly preview: {
    readonly kind: "bug" | "confusing" | "missing_capability" | "wrong_docs" | "other";
    readonly subject: string;
    readonly expected: string;
    readonly actual: string;
    readonly workaround: string;
    readonly trace: Wire120 | null;
  };
  readonly conversationTrace?: Wire120;
  readonly feedbackStatus: "pending" | "sent" | "declined" | "cancelled";
};

export type Wire121 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "subagent";
  readonly subagentId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly childThreadId: string | null;
  readonly remoteChild?: Wire54;
  readonly prompt: string;
  readonly progress?: Wire37;
  readonly result: string | null;
  readonly promptOmitted?: true;
  readonly resultOmitted?: true;
};

export type Wire122 = {
  readonly deferredWork?: Wire79;
  readonly toolNonExecutionKind?: Wire37;
  readonly toolSurface?: Wire80;
  readonly toolIcon?: Wire81;
  readonly toolSource?: Wire82;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire83;
  readonly nodeId: Wire84;
  readonly providerThreadId: Wire85;
  readonly providerTurnId: Wire86;
  readonly nativeItemRef: Wire87;
  readonly parentItemId: Wire88;
  readonly ordinal: number;
  readonly status: Wire89;
  readonly title: Wire90;
  readonly startedAt: Wire91;
  readonly completedAt: Wire92;
  readonly updatedAt: string;
  readonly type: "dynamic_tool";
  readonly toolName: string | null;
  readonly viewedImagePath?: Wire8;
  readonly input: unknown;
  readonly output?: Wire4;
  readonly outputOmitted?: Wire6;
};

export type Wire123 = {
  readonly threadId: string;
  readonly runId?: Wire8;
  readonly checkpointId?: Wire8;
  readonly turnItemId?: Wire8;
  readonly providerThreadRef?: Wire59;
  readonly providerTurnRef?: Wire59;
};

export type Wire124 =
  | { readonly type: "latest_stable" }
  | { readonly type: "run"; readonly runId: string }
  | { readonly type: "checkpoint"; readonly checkpointId: string };

export type Wire125 = globalThis.ReadonlyArray<{
  readonly provider: string;
  readonly model: string;
}>;

export type Wire126 = {
  readonly [x: string]: {
    readonly hiddenModels?: globalThis.ReadonlyArray<string> | undefined;
    readonly modelOrder?: globalThis.ReadonlyArray<string> | undefined;
  };
};

export type Wire129 = "any-local-files" | "uncommitted-changes" | "tracked-changes";

export type Wire128 = Wire129 | undefined;

export type Wire130 = number | null;

export type Wire132 = number | null;

export type Wire131 = Wire132 | undefined;

export type Wire127 =
  | { readonly mode: "off" }
  | {
      readonly mode: "custom";
      readonly rules: {
        readonly worktreeKeepWhen?: Wire128;
        readonly worktreeAfterDays: Wire130;
        readonly worktreeSettledAfterDays?: Wire131;
        readonly worktreeOnMerge: boolean;
        readonly worktreeOnDelete: boolean;
        readonly worktreeUnchanged: boolean;
      };
    }
  | null;

export type Wire133 = Wire130 | undefined;

export type Wire134 = "turn" | "paragraph";

export type Wire135 = "off" | "on-request" | "auto";

export type Wire138 = { readonly provider: string; readonly reference: string };

export type Wire137 = string | Wire138;

export type Wire136 = Wire137 | undefined;

export type Wire139 = "auto" | "cpu" | string;

export type Wire140 = "never" | "immediately" | "min_2" | "min_5" | "min_10" | "min_15" | "hour_1";

export type Wire141 = globalThis.ReadonlyArray<{
  readonly term: string;
  readonly aliases: globalThis.ReadonlyArray<string>;
}>;

export type Wire142 = Wire3 | null;

export type Wire143 = globalThis.ReadonlyArray<Wire7>;

export type Wire144 = Wire3 | null;

export type Wire145 = Wire3 | null;

export type Wire148 = "repo_conventions" | "conventional_commits" | "custom";

export type Wire147 = {
  readonly mode?: Wire148 | undefined;
  readonly customInstructions?: Wire37;
  readonly followChangeRequestTemplates?: Wire6;
};

export type Wire146 = Wire147 | string;

export type Wire149 = "static" | "semantic" | "custom";

export type Wire151 = "merge" | "squash" | "rebase" | "fast-forward";

export type Wire150 = Wire151 | null;

export type Wire152 = number | null;

export type Wire153 = { readonly [x: string]: { readonly enabled?: boolean } };

export type Wire154 = globalThis.ReadonlyArray<{
  readonly kind?: "ssh";
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly identityFile?: Wire8;
  readonly port?: number | undefined;
}>;

export type Wire155 = globalThis.ReadonlyArray<{
  readonly kind: "eas";
  readonly id: string;
  readonly label: string;
  readonly appId?: Wire8;
  readonly accessToken?: Wire137;
  readonly maxSessionMinutes?: number;
  readonly idleMinutes?: number;
  readonly maxConcurrentSessions?: number;
}>;

export type Wire156 = globalThis.ReadonlyArray<{
  readonly kind: "simlock";
  readonly id: string;
  readonly label: string;
  readonly gatewayUrl: string;
  readonly agentToken?: Wire137;
  readonly maxLeases?: number;
  readonly maxLeaseMinutes?: number;
}>;

export type Wire158 = "onReturn" | "beforeCacheExpires" | "off";

export type Wire157 = boolean | Wire158;

export type Wire159 =
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

export type Wire160 = "balanced" | "performance" | "battery-saver" | "custom";

export type Wire161 = "balanced" | "performance" | "battery-saver";

export type Wire162 = {
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly hostPowerMonitorActiveInterval?: number;
  readonly hostPowerMonitorIdleInterval?: number;
  readonly pauseWhenHostLocked?: boolean;
  readonly pauseWhenHostLowPower?: boolean;
  readonly pauseWhenClientLowPower?: boolean;
  readonly pauseWhenOnBattery?: boolean;
};

export type Wire163 = number | undefined;

export type Wire164 = "" | "light" | "dark" | "system";

export type Wire165 = {
  readonly driver: string;
  readonly displayName?: Wire8;
  readonly accentColor?: Wire8;
  readonly environment?: globalThis.ReadonlyArray<{
    readonly name: string;
    readonly value?: Wire37;
    readonly sensitive?: Wire6;
    readonly valueRedacted?: boolean;
    readonly secret?: Wire138;
  }>;
  readonly enabled?: boolean;
  readonly config?: unknown;
};

export type Wire166 = { readonly [x: string]: unknown };

export type Wire167 = {
  readonly kind: "cliproxy";
  readonly label?: Wire8;
  readonly url: string;
  readonly managementKey?: Wire136;
  readonly enabled?: Wire6;
};

export type Wire168 = {
  readonly kind: "openaiCompatible" | "anthropic";
  readonly label?: Wire8;
  readonly baseUrl: string;
  readonly apiKey?: Wire136;
  readonly enabled?: Wire6;
};

export type Wire169 = number | "unlimited";

export type Wire170 = {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly cacheReadCostPerMillionTokens?: number;
  readonly cacheWriteCostPerMillionTokens?: number;
};

export type Wire171 = globalThis.ReadonlyArray<{
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
    readonly defaultThreadEnvMode?: Wire5 | null | undefined;
    readonly autoPull?: Wire6;
    readonly scripts: globalThis.ReadonlyArray<Wire7>;
    readonly trackedFolders?:
      | globalThis.ReadonlyArray<{
          readonly path: string;
          readonly name: string;
          readonly discovered?: Wire6;
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
  readonly threads: globalThis.ReadonlyArray<Wire9>;
  readonly archivedThreads: globalThis.ReadonlyArray<Wire9>;
};

export type ThreadSnapshot = {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly projection: {
    readonly thread: {
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly id: string;
      readonly projectId: string;
      readonly title: string;
      readonly providerInstanceId: string;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire12;
      readonly interactionMode: Wire13;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly linkedPullRequest?: Wire14 | null | undefined;
      readonly pullRequests?: globalThis.ReadonlyArray<Wire15> | undefined;
      readonly branchPullRequest?: Wire14 | null | undefined;
      readonly issues?: globalThis.ReadonlyArray<Wire22> | undefined;
      readonly activeProviderThreadId: string | null;
      readonly historyOrigin?: Wire26;
      readonly linkOrigin?: Wire27;
      readonly delegatedFrom?: Wire29;
      readonly workflowRun?: Wire30;
      readonly lineage: Wire24;
      readonly forkedFrom: Wire25;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly archivedAt: string | null;
      readonly settledOverride?: "settled" | "active" | null | undefined;
      readonly settledAt?: string | null | undefined;
      readonly unsettledAt?: string | null | undefined;
      readonly snoozedUntil?: string | null | undefined;
      readonly snoozedAt?: string | null | undefined;
      readonly lastSnoozeWakeAt?: string | null | undefined;
      readonly limitRecovery?: Wire40 | null | undefined;
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
              readonly attachments?: globalThis.ReadonlyArray<Wire45> | undefined;
            }>;
          }
        | null
        | undefined;
      readonly pinnedAt?: string | null | undefined;
      readonly autoSettleDisabledAt?: string | null | undefined;
      readonly pinOrderKey?: string | null | undefined;
      readonly activeOrderKey?: string | null | undefined;
      readonly tags?: Wire41;
      readonly lastVisitedAt?: string | null | undefined;
      readonly opens?: Wire42;
      readonly titleRegeneration?:
        | { readonly requestId: string; readonly startedAt: string }
        | null
        | undefined;
      readonly lastTitleRegeneration?: Wire43 | null | undefined;
      readonly titleRenamed?: Wire6;
      readonly rollbackRequestId?: Wire8;
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
      readonly status: Wire31;
      readonly queuePosition?: number | null | undefined;
      readonly queueHeld?: Wire6;
      readonly steerWhenReadyRunId?: Wire8;
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly checkpointId: string | null;
      readonly contextHandoffId: string | null;
      readonly restartContinuationOfRunId?: Wire8;
      readonly manualContinuationOfRunId?: Wire8;
      readonly usageLimitContinuationOfRunId?: Wire8;
      readonly delegatedTaskId?: Wire8;
      readonly workStartedAt?: Wire49;
      readonly restartCancelledBackgroundWork?:
        | globalThis.ReadonlyArray<{
            readonly kind: "subagent" | "shell" | "monitor" | "task";
            readonly label: string;
            readonly id?: Wire8;
            readonly awaited?: true | undefined;
          }>
        | undefined;
      readonly sourcePlanRef?: { readonly threadId: string; readonly planId: string } | undefined;
      readonly delegatedCompletion?:
        | {
            readonly disposition: "open" | "stopped" | "disposed";
            readonly nextGeneration: number;
            readonly delivery: {
              readonly generation: number;
              readonly messageId: string;
              readonly taskIds: globalThis.ReadonlyArray<string>;
            } | null;
          }
        | undefined;
      readonly workspacePreparation?: Wire50;
      readonly freshContext?: Wire6;
      readonly outputSchema?: { readonly [x: string]: Json } | undefined;
      readonly output?: { readonly value: Json; readonly submittedAt: string } | undefined;
    }>;
    readonly attempts: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly nativeThreadId?: Wire37;
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
      readonly nativeItemRef: Wire52 | null;
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
      readonly createdBy: Wire10;
      readonly driver: string;
      readonly providerInstanceId: string;
      readonly providerThreadId: string | null;
      readonly childThreadId: string | null;
      readonly remoteChild?: Wire54;
      readonly nativeTaskRef: Wire52 | null;
      readonly prompt: string;
      readonly title: string | null;
      readonly model: string | null;
      readonly modelSelection?: Wire55;
      readonly executedModel?: Wire37;
      readonly completionWake?: "always" | "settled_only" | undefined;
      readonly completionDelivery?:
        | {
            readonly state: "pending" | "claimed" | "acknowledged" | "delivered" | "disposed";
            readonly observedByRunId: string | null;
          }
        | undefined;
      readonly cancelledRunId?: Wire8;
      readonly status:
        | "idle"
        | "pending"
        | "running"
        | "waiting"
        | "completed"
        | "failed"
        | "cancelled"
        | "interrupted";
      readonly progress?: Wire37;
      readonly workflow?:
        | {
            readonly name?: Wire8;
            readonly runHandles?:
              | {
                  readonly runId?: Wire8;
                  readonly transcriptDir?: Wire8;
                  readonly scriptPath?: Wire8;
                }
              | undefined;
            readonly phases: globalThis.ReadonlyArray<{
              readonly index: number;
              readonly title: string;
            }>;
            readonly agents: globalThis.ReadonlyArray<{
              readonly index: number;
              readonly label: string;
              readonly agentId?: Wire8;
              readonly childThreadId?: Wire8;
              readonly state: "queued" | "running" | "completed" | "failed";
              readonly phaseIndex?: Wire19;
              readonly phaseTitle?: Wire8;
              readonly model?: Wire8;
              readonly effort?: Wire8;
              readonly speed?: Wire8;
              readonly attempt?: Wire19;
              readonly totalTokens?: Wire19;
              readonly toolCalls?: Wire19;
              readonly durationMs?: Wire19;
              readonly queuedAt?: Wire19;
              readonly startedAt?: Wire19;
              readonly completedAt?: Wire19;
              readonly prompt?: Wire56;
              readonly result?: Wire56;
            }>;
            readonly totalTokens?: Wire19;
            readonly toolCalls?: Wire19;
            readonly durationMs?: Wire19;
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
          readonly canForkWhileSourceRunning?: Wire6;
          readonly canForkFromSubagentThread: boolean;
          readonly exposesNativeThreadId: boolean;
        };
        readonly turns: {
          readonly supportsNativeGoals?: Wire6;
          readonly exposesNativeTurnId: boolean;
          readonly emitsTurnStarted: boolean;
          readonly emitsTurnCompleted: boolean;
          readonly supportsInterrupt: boolean;
          readonly supportsNativeResume?: Wire6;
          readonly supportsActiveSteering: boolean;
          readonly activeSteeringInterruptsTools?: Wire6;
          readonly activeSteeringAcceptsAttachments?: Wire6;
          readonly activeSteeringDuringCompaction?: Wire6;
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
          readonly supportsBackgroundWait?: Wire6;
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
          readonly nativeThreadIds: Wire53;
          readonly nativeTurnIds: Wire53;
          readonly nativeItemIds: Wire53;
          readonly nativeRequestIds: Wire53;
        };
        readonly runtimePolicy?: { readonly enforcement: "native" | "client-boundary" } | undefined;
      };
      readonly extensionStatuses?:
        | globalThis.ReadonlyArray<{ readonly key: string; readonly text: string }>
        | undefined
        | undefined;
      readonly startupPhase?: string;
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
      readonly nativeThreadRef: Wire52 | null;
      readonly nativeConversationHeadRef: Wire52 | null;
      readonly status: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
      readonly firstRunOrdinal: number | null;
      readonly lastRunOrdinal: number | null;
      readonly handoffIds: globalThis.ReadonlyArray<string>;
      readonly forkedFrom: {
        readonly providerThreadId: string;
        readonly providerTurnId?: Wire8;
        readonly checkpointId?: Wire8;
      } | null;
      readonly pendingBackgroundTasks?: globalThis.ReadonlyArray<Wire36> | undefined | undefined;
      readonly contextUsage?:
        | {
            readonly usedTokens: number;
            readonly totalProcessedTokens?: Wire19;
            readonly maxTokens?: Wire57;
            readonly inputTokens?: Wire19;
            readonly cachedInputTokens?: Wire19;
            readonly outputTokens?: Wire19;
            readonly reasoningOutputTokens?: Wire19;
            readonly lastUsedTokens?: Wire19;
            readonly lastInputTokens?: Wire19;
            readonly lastCachedInputTokens?: Wire19;
            readonly lastOutputTokens?: Wire19;
            readonly lastReasoningOutputTokens?: Wire19;
            readonly toolUses?: Wire19;
            readonly durationMs?: Wire19;
            readonly compactsAutomatically?: Wire6;
            readonly autoCompactThreshold?: Wire57;
            readonly cost?: { readonly amount: number; readonly currency: string } | undefined;
          }
        | null
        | undefined
        | undefined;
      readonly nativeMetadata?: Wire58 | null | undefined | undefined;
      readonly goal?: Wire39 | null | undefined | undefined;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly providerTurns: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly providerThreadId: string;
      readonly nodeId: string;
      readonly runAttemptId: string | null;
      readonly nativeTurnRef: Wire52 | null;
      readonly nativeThreadRef?: Wire59;
      readonly ordinal: number;
      readonly status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly tokenUsage?: Wire60;
      readonly turnTokenUsage?:
        | {
            readonly usageScope: "main_agent";
            readonly cachedInputTokens?: Wire19;
            readonly cacheCreationTokens?: Wire19;
            readonly reasoningTokens?: Wire19;
            readonly hasSubagents: boolean;
            readonly models?: Wire61;
            readonly localCommand?: Wire6;
            readonly otherUsage?: Wire62;
            readonly usageStatus: "complete";
            readonly inputTokens: number;
            readonly outputTokens: number;
          }
        | {
            readonly usageScope: "main_agent";
            readonly cachedInputTokens?: Wire19;
            readonly cacheCreationTokens?: Wire19;
            readonly reasoningTokens?: Wire19;
            readonly hasSubagents: boolean;
            readonly models?: Wire61;
            readonly localCommand?: Wire6;
            readonly otherUsage?: Wire62;
            readonly usageStatus: "partial" | "unavailable";
            readonly inputTokens?: Wire19;
            readonly outputTokens?: Wire19;
          }
        | undefined;
      readonly model?: Wire8;
      readonly promptDropped?: true | undefined;
    }>;
    readonly runtimeRequests: globalThis.ReadonlyArray<{
      readonly id: string;
      readonly nodeId: string;
      readonly providerTurnId: string | null;
      readonly nativeRequestRef: Wire52 | null;
      readonly kind: Wire33;
      readonly status: "pending" | "resolved" | "expired" | "cancelled";
      readonly responseCapability:
        | {
            readonly type: "live";
            readonly providerSessionId: string;
            readonly supportsFeedback?: Wire6;
          }
        | { readonly type: "message" }
        | { readonly type: "not_resumable"; readonly reason: string };
      readonly createdAt: string;
      readonly resolvedAt: string | null;
      readonly decision?: Wire63;
      readonly feedback?: Wire37;
      readonly answers?: Wire65;
    }>;
    readonly messages: globalThis.ReadonlyArray<{
      readonly notification?: Wire67;
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly scheduledTaskId?: Wire8;
      readonly followsThreadSelection?: true | undefined;
      readonly senderThreadId?: Wire8;
      readonly linkedSender?: Wire71;
      readonly idleCompaction?: Wire72;
      readonly workflowScript?: Wire6;
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly nodeId: string | null;
      readonly role: Wire35;
      readonly text: string;
      readonly context?: Wire73;
      readonly attachments: globalThis.ReadonlyArray<Wire45>;
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
          readonly runId: Wire74;
          readonly nodeId: string;
          readonly status: Wire75;
          readonly detailInTurnItem?: Wire76;
          readonly kind: "proposed_plan";
          readonly markdown: string;
        }
      | {
          readonly id: string;
          readonly threadId: string;
          readonly runId: Wire74;
          readonly nodeId: string;
          readonly status: Wire75;
          readonly detailInTurnItem?: Wire76;
          readonly kind: "todo_list";
          readonly steps: globalThis.ReadonlyArray<Wire77>;
          readonly explanation?: Wire37;
        }
    >;
    readonly turnItems: globalThis.ReadonlyArray<
      | Wire78
      | Wire93
      | Wire94
      | Wire95
      | Wire96
      | Wire97
      | Wire98
      | Wire100
      | Wire101
      | Wire102
      | Wire103
      | Wire104
      | Wire105
      | Wire108
      | Wire109
      | Wire110
      | Wire111
      | Wire113
      | Wire114
      | Wire115
      | Wire116
      | Wire117
      | Wire118
      | Wire119
      | Wire121
      | Wire122
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
      readonly files: globalThis.ReadonlyArray<Wire106>;
      readonly filesTotal?: Wire107;
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
              readonly runStatus?: Wire37;
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
      readonly sourcePoint: Wire123;
      readonly basePoint: Wire123 | null;
      readonly sourceProviderInstanceId: string | null;
      readonly sourceTokenUsage?: Wire60;
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
        | { readonly strategy: "native_fork"; readonly providerThreadRef: Wire52 }
        | { readonly strategy: "portable_context"; readonly contextHandoffId: string }
        | { readonly strategy: "delta_context"; readonly contextHandoffId: string }
        | { readonly strategy: "fork_delta_context"; readonly contextHandoffId: string }
        | { readonly strategy: "checkpoint_context"; readonly contextHandoffId: string }
        | null;
      readonly createdBy: Wire10;
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
        | Wire78
        | Wire93
        | Wire94
        | Wire95
        | Wire96
        | Wire97
        | Wire98
        | Wire100
        | Wire101
        | Wire102
        | Wire103
        | Wire104
        | Wire105
        | Wire108
        | Wire109
        | Wire110
        | Wire111
        | Wire113
        | Wire114
        | Wire115
        | Wire116
        | Wire117
        | Wire118
        | Wire119
        | Wire121
        | Wire122
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
      readonly reason?: Wire37;
      readonly stopDelegatedTasks?: Wire6;
    }
  | {
      readonly type: "thread.create";
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly titleRenamed?: Wire6;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire12;
      readonly interactionMode: Wire13;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly linkOrigin?: Wire27;
      readonly delegatedFrom?: Wire29;
      readonly workflowRun?: Wire30;
      readonly importedNativeThread?:
        | {
            readonly ref: {
              readonly driver: string;
              readonly nativeId: string;
              readonly strength: "strong";
            };
            readonly metadata?: Wire58 | undefined;
          }
        | undefined;
      readonly initialMessage?:
        | {
            readonly messageId: string;
            readonly text: string;
            readonly attachments: globalThis.ReadonlyArray<Wire45>;
            readonly context?: Wire73;
            readonly titleSeed?: Wire8;
            readonly scheduledTaskId?: Wire8;
            readonly senderThreadId?: Wire8;
            readonly outputSchema?: { readonly [x: string]: Json } | undefined;
            readonly workspaceStrategy?: Wire50;
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
      readonly onlyIfUnused?: Wire6;
    }
  | {
      readonly type: "thread.settle";
      readonly commandId: string;
      readonly threadId: string;
      readonly expectedLatestRunId?: Wire8;
      readonly settledAt?: Wire49;
    }
  | {
      readonly type: "thread.auto-settle";
      readonly commandId: string;
      readonly threadId: string;
      readonly snapshotAt: string;
      readonly settledAt?: Wire49;
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
      readonly orderKey?: Wire8;
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
      readonly opened?: Wire6;
      readonly searchQuery?: string | undefined;
    }
  | { readonly type: "thread.mark-unread"; readonly commandId: string; readonly threadId: string }
  | {
      readonly type: "thread.metadata.update";
      readonly commandId: string;
      readonly threadId: string;
      readonly title?: Wire8;
      readonly regenerateTitle?: Wire6;
      readonly branch?: string | null | undefined;
      readonly worktreePath?: string | null | undefined;
      readonly expectedWorktreePath?: string | null | undefined;
      readonly expectedBranch?: string | null | undefined;
      readonly continuation?: { readonly messageId: string; readonly text: string } | undefined;
      readonly expectedEmpty?: Wire6;
      readonly limitRecovery?:
        | {
            readonly runId: string;
            readonly resetAt: string;
            readonly autoResume?: Wire6;
            readonly snooze?: Wire6;
          }
        | null
        | undefined;
      readonly linkedPullRequest?: Wire14 | null | undefined;
    }
  | {
      readonly type: "thread.pull-request.link";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly source: Wire16;
      readonly repositoryWebUrl?: Wire8;
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
      readonly snapshot: Wire17;
      readonly stack: Wire20 | null;
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
      readonly source: Wire23;
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
      readonly checksPending?: Wire6;
      readonly link?:
        | { readonly url: string; readonly source: Wire16; readonly repositoryWebUrl?: Wire8 }
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
        readonly linkedPullRequest: Wire14 | null;
        readonly branchPullRequest: Wire14 | null;
      };
      readonly branchPullRequest: Wire14 | null;
      readonly linkedPullRequest?: Wire14 | undefined;
    }
  | {
      readonly type: "thread.title.regeneration.complete";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly title?: Wire8;
      readonly outcome?: { readonly status: Wire44; readonly message?: Wire37 } | undefined;
    }
  | {
      readonly type: "thread.runtime-mode.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly runtimeMode: Wire12;
    }
  | {
      readonly type: "thread.interaction-mode.set";
      readonly commandId: string;
      readonly threadId: string;
      readonly interactionMode: Wire13;
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
      readonly reason?: Wire37;
    }
  | {
      readonly type: "message.dispatch";
      readonly notification?: Wire67;
      readonly guestMessageId?: Wire8;
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly scheduledTaskId?: Wire8;
      readonly senderThreadId?: Wire8;
      readonly linkedSender?: Wire71;
      readonly idleCompaction?: Wire72;
      readonly freshContext?: Wire6;
      readonly outputSchema?: { readonly [x: string]: Json } | undefined;
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string;
      readonly context?: Wire73;
      readonly attachments: globalThis.ReadonlyArray<Wire45>;
      readonly titleSeed?: Wire8;
      readonly modelSelection?: Wire55;
      readonly sourcePlanRef?: { readonly threadId: string; readonly planId: string } | undefined;
      readonly restartContinuationOfRunId?: Wire8;
      readonly usageLimitContinuationOfRunId?: Wire8;
      readonly manualContinuationOfRunId?: Wire8;
      readonly steerFollowUpOfRunId?: Wire8;
      readonly steerFollowUpAfterRunOrdinal?: Wire19;
      readonly usageLimitRecoveryRequestId?: Wire8;
      readonly deliveryIntent?: "auto" | "steer" | "restart" | undefined;
      readonly delegatedCompletion?:
        | {
            readonly parentRunId: string;
            readonly generation: number;
            readonly taskIds: globalThis.ReadonlyArray<string>;
          }
        | undefined;
      readonly dispatchMode:
        | { readonly type: "defer_start"; readonly workspaceStrategy?: Wire50 }
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
      readonly failure: Wire112;
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
      readonly reason?: Wire37;
      readonly holdQueue?: Wire6;
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
      readonly context?: Wire73;
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly text: string;
      readonly attachments?: globalThis.ReadonlyArray<Wire45> | undefined;
    }
  | {
      readonly type: "runtime-request.respond";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision?: Wire63;
      readonly feedback?: Wire37;
      readonly answers?: Wire65;
      readonly attachmentsByQuestionId?: Wire99 | undefined;
    }
  | {
      readonly type: "thread.user-input.dismiss";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
    }
  | {
      readonly type: "checkpoint.rollback";
      readonly restoreFiles?: Wire6;
      readonly commandId: string;
      readonly threadId: string;
      readonly scopeId: string;
      readonly checkpointId: string;
    }
  | {
      readonly type: "thread.fork";
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly commandId: string;
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire124;
      readonly title?: Wire8;
      readonly sideChat?: Wire6;
      readonly createdAt?: Wire49;
    }
  | {
      readonly type: "thread.merge_back";
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly commandId: string;
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire124;
      readonly createdAt?: Wire49;
    }
  | {
      readonly type: "delegated_task.request";
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly commandId: string;
      readonly parentThreadId: string;
      readonly parentRunId: string;
      readonly parentNodeId: string;
      readonly task: string;
      readonly title?: Wire8;
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire12;
      readonly interactionMode: Wire13;
      readonly workspaceStrategy?: Wire50;
      readonly completionWake?: "always" | "settled_only" | undefined;
      readonly createdAt?: Wire49;
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
  readonly favorites?: Wire125 | null | undefined;
  readonly providerModelPreferences?: Wire126 | null | undefined;
  readonly worktreeCleanup?: Wire127 | undefined;
  readonly storageCleanup?:
    | {
        readonly worktreeKeepWhen?: Wire128;
        readonly worktreeAfterDays?: Wire133;
        readonly worktreeSettledAfterDays?: Wire131;
        readonly worktreeOnMerge?: Wire6;
        readonly worktreeOnDelete?: Wire6;
        readonly worktreeUnchanged?: Wire6;
        readonly browserArtifactsAfterDays?: Wire133;
        readonly logsAfterDays?: Wire133;
      }
    | undefined;
  readonly worktreesDirectory?: Wire37;
  readonly fastWorktreeCheckout?: Wire6;
  readonly previousWorktreesDirectories?: globalThis.ReadonlyArray<string> | undefined;
  readonly responseStreamingMode?: Wire134 | undefined;
  readonly agentFeedback?: { readonly mode?: Wire135 } | undefined;
  readonly enableProviderUpdateChecks?: Wire6;
  readonly continueThreadsAfterServerUpdate?: Wire6;
  readonly keepAwakeWhileAgentsWork?: Wire6;
  readonly requireConnectDeviceApproval?: Wire6;
  readonly enableAgentBrowserAccess?: Wire6;
  readonly enablePreviewTunnel?: Wire6;
  readonly cloudSpeechCredentials?:
    | { readonly openai?: Wire136; readonly xai?: Wire136; readonly openrouter?: Wire136 }
    | undefined;
  readonly speechModelId?: Wire37;
  readonly speechAcceleration?: Wire139 | undefined;
  readonly speechModelUnloadTimeout?: Wire140 | undefined;
  readonly speechProjectCustomWords?: Wire141 | undefined;
  readonly speechPostProcessingModelSelection?: Wire3 | null | undefined;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultAutoPull?: Wire6;
  readonly defaultProjectScripts?: globalThis.ReadonlyArray<Wire7> | undefined;
  readonly projectScriptOverrides?:
    | { readonly [x: string]: globalThis.ReadonlyArray<Wire7> | null }
    | undefined;
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultModelSelection?: Wire3 | null | undefined;
  readonly fallbackModelSelection?: Wire3 | null | undefined;
  readonly defaultRuntimeMode?: Wire12 | undefined;
  readonly projectSettingsOverrides?:
    | {
        readonly [x: string]: {
          readonly worktreeCleanup?: Wire127;
          readonly defaultModelSelection?: Wire142;
          readonly defaultRuntimeMode?: Wire12;
          readonly defaultThreadEnvMode?: Wire5;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire143;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire144;
          readonly reviewGuideModelSelection?: Wire145;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire146;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire149;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire150;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire152;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire134;
          readonly speechProjectCustomWords?: Wire141;
          readonly providerInstances?: Wire153;
        } & { readonly [x: string]: unknown };
      }
    | undefined;
  readonly projectSettingsFolded?: Wire6;
  readonly enableAgentDeviceAccess?: Wire6;
  readonly enableDeviceSupport?: Wire6;
  readonly deviceOnboardingCompleted?: Wire6;
  readonly deviceHosts?: Wire154 | undefined;
  readonly easDeviceHosts?: Wire155 | undefined;
  readonly simlockDeviceHosts?: Wire156 | undefined;
  readonly simlockDeviceHostsEnabled?: Wire6;
  readonly sidebarAutoSettleAfterDays?: number | null | undefined;
  readonly compactIdleThreads?: Wire157 | undefined;
  readonly idleCompaction?: Wire158;
  readonly snoozeLimitedThreads?: Wire6;
  readonly autoResumeLimitedThreads?: Wire6;
  readonly snoozePresets?: globalThis.ReadonlyArray<Wire159> | undefined;
  readonly hiddenThreadTags?: globalThis.ReadonlyArray<unknown> | undefined;
  readonly hideTaggedThreads?: Wire6;
  readonly guestSharingEnabled?: Wire6;
  readonly linkedEnvironmentsEnabled?: Wire6;
  readonly workflowsEnabled?: Wire6;
  readonly promptSuggestionsEnabled?: Wire6;
  readonly sidebarAutoSettleKeepPullRequests?: Wire6;
  readonly sidebarAutoSettleOnMerge?: Wire6;
  readonly backgroundActivity?:
    | {
        readonly schemaVersion?: 1 | undefined;
        readonly profile?: Wire160 | undefined;
        readonly baseProfile?: Wire161;
        readonly overrides?: Wire162 | undefined;
      }
    | undefined;
  readonly automaticGitFetchInterval?: Wire163;
  readonly providerHealthRefreshInterval?: Wire163;
  readonly backgroundActivityProfile?: Wire161 | undefined;
  readonly defaultTheme?: string | undefined;
  readonly defaultThemeSetAt?: string | undefined;
  readonly defaultAppearance?: Wire164 | undefined;
  readonly defaultAppearanceSetAt?: string | undefined;
  readonly environmentIcon?: Wire4;
  readonly defaultThreadEnvMode?: unknown;
  readonly newWorktreesStartFromOrigin?: Wire6;
  readonly worktreeSubmodules?: Wire4;
  readonly addProjectBaseDirectory?: Wire37;
  readonly ghqCloneLayout?: Wire6;
  readonly textGenerationModelSelection?: Wire3 | undefined;
  readonly threadTitleInstructions?: Wire37;
  readonly branchNamingMode?: Wire149 | undefined;
  readonly branchNamePrefix?: Wire37;
  readonly branchNameInstructions?: Wire37;
  readonly removeAgentCreditsOnMerge?: Wire6;
  readonly sourceControlWritingStyle?: Wire146 | undefined;
  readonly sourceControlWriterModelSelection?: Wire3 | null | undefined;
  readonly reviewGuidesEnabled?: Wire6;
  readonly reviewGuideModelSelection?: Wire3 | null | undefined;
  readonly reviewGuideInstructions?: Wire37;
  readonly pullRequestMergeMethod?: Wire151 | null | undefined;
  readonly providerInstances?: { readonly [x: string]: Wire165 } | undefined;
  readonly observability?:
    | {
        readonly otlpTracesUrl?: Wire37;
        readonly otlpMetricsUrl?: Wire37;
        readonly otlpLogsUrl?: Wire37;
      }
    | undefined;
  readonly sourceControlHosts?: { readonly [x: string]: Wire166 } | undefined;
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean } | undefined;
  readonly usageLimitSources?: { readonly [x: string]: Wire167 } | undefined;
  readonly textGenerators?: { readonly [x: string]: Wire168 } | undefined;
  readonly secretProviders?:
    | {
        readonly [x: string]: {
          readonly kind: string;
          readonly label: string;
          readonly config?: unknown;
        };
      }
    | undefined;
  readonly usageHistoryRetentionDays?: Wire169 | undefined;
  readonly usagePriceOverrides?: { readonly [x: string]: Wire170 } | undefined;
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
  readonly favorites?: Wire125;
  readonly providerModelPreferences?: Wire126;
  readonly migrateModelPreferences?: {
    readonly favorites?: Wire125;
    readonly providerModelPreferences?: Wire126;
  };
  readonly worktreeCleanup?:
    | { readonly mode: "off" }
    | {
        readonly mode: "custom";
        readonly rules: {
          readonly worktreeKeepWhen?: Wire129;
          readonly worktreeAfterDays?: Wire130;
          readonly worktreeSettledAfterDays?: Wire132;
          readonly worktreeOnMerge?: boolean;
          readonly worktreeOnDelete?: boolean;
          readonly worktreeUnchanged?: boolean;
        };
      }
    | null;
  readonly storageCleanup?: {
    readonly worktreeKeepWhen?: Wire129;
    readonly worktreeAfterDays?: Wire130;
    readonly worktreeSettledAfterDays?: Wire132;
    readonly worktreeOnMerge?: boolean;
    readonly worktreeOnDelete?: boolean;
    readonly worktreeUnchanged?: boolean;
    readonly browserArtifactsAfterDays?: Wire130;
    readonly logsAfterDays?: Wire130;
  };
  readonly worktreesDirectory?: string;
  readonly fastWorktreeCheckout?: boolean;
  readonly responseStreamingMode?: Wire134;
  readonly agentFeedback?: { readonly mode: Wire135 };
  readonly enableProviderUpdateChecks?: boolean;
  readonly continueThreadsAfterServerUpdate?: boolean;
  readonly keepAwakeWhileAgentsWork?: boolean;
  readonly requireConnectDeviceApproval?: boolean;
  readonly enableAgentBrowserAccess?: boolean;
  readonly enablePreviewTunnel?: boolean;
  readonly cloudSpeechCredentials?: {
    readonly openai?: Wire137;
    readonly xai?: Wire137;
    readonly openrouter?: Wire137;
  };
  readonly speechModelId?: string;
  readonly speechAcceleration?: Wire139;
  readonly speechModelUnloadTimeout?: Wire140;
  readonly speechProjectCustomWords?: Wire171;
  readonly speechPostProcessingModelSelection?: Wire3 | null;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultAutoPull?: boolean;
  readonly defaultProjectScripts?: globalThis.ReadonlyArray<Wire7>;
  readonly projectScriptOverrides?: {
    readonly [x: string]: globalThis.ReadonlyArray<Wire7> | null;
  };
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultModelSelection?: Wire3 | null;
  readonly defaultRuntimeMode?: Wire12;
  readonly fallbackModelSelection?: Wire3 | null;
  readonly projectSettingsOverrides?: {
    readonly [x: string]:
      | ({
          readonly worktreeCleanup?: Wire127;
          readonly defaultModelSelection?: Wire142;
          readonly defaultRuntimeMode?: Wire12;
          readonly defaultThreadEnvMode?: Wire5;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire143;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire144;
          readonly reviewGuideModelSelection?: Wire145;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire147;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire149;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire150;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire152;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire134;
          readonly speechProjectCustomWords?: Wire171;
          readonly providerInstances?: Wire153;
        } & { readonly [x: string]: unknown })
      | null;
  };
  readonly enableAgentDeviceAccess?: boolean;
  readonly enableDeviceSupport?: boolean;
  readonly deviceOnboardingCompleted?: boolean;
  readonly deviceHosts?: Wire154;
  readonly easDeviceHosts?: Wire155;
  readonly simlockDeviceHosts?: Wire156;
  readonly simlockDeviceHostsEnabled?: boolean;
  readonly sidebarAutoSettleAfterDays?: number | null;
  readonly compactIdleThreads?: Wire157;
  readonly idleCompaction?: Wire158;
  readonly sidebarAutoSettleKeepPullRequests?: boolean;
  readonly sidebarAutoSettleOnMerge?: boolean;
  readonly autoResumeLimitedThreads?: boolean;
  readonly snoozeLimitedThreads?: boolean;
  readonly snoozePresets?: globalThis.ReadonlyArray<Wire159>;
  readonly hiddenThreadTags?: globalThis.ReadonlyArray<string>;
  readonly hideTaggedThreads?: boolean;
  readonly guestSharingEnabled?: boolean;
  readonly linkedEnvironmentsEnabled?: boolean;
  readonly workflowsEnabled?: boolean;
  readonly promptSuggestionsEnabled?: boolean;
  readonly backgroundActivity?: {
    readonly schemaVersion?: 1;
    readonly profile?: Wire160;
    readonly baseProfile?: Wire161;
    readonly overrides?: Wire162;
  };
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly backgroundActivityProfile?: Wire161;
  readonly defaultTheme?: string;
  readonly defaultThemeSetAt?: string;
  readonly defaultAppearance?: Wire164;
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
  readonly defaultThreadEnvMode?: Wire5 | null;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly worktreeSubmodules?: "recursive" | "top-level" | "none" | null;
  readonly addProjectBaseDirectory?: string;
  readonly ghqCloneLayout?: boolean;
  readonly textGenerationModelSelection?: {
    readonly instanceId?: string;
    readonly model?: string;
    readonly options?:
      | globalThis.ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
      | { readonly [x: string]: unknown };
  };
  readonly threadTitleInstructions?: string;
  readonly branchNamingMode?: Wire149;
  readonly branchNamePrefix?: string;
  readonly branchNameInstructions?: string;
  readonly removeAgentCreditsOnMerge?: boolean;
  readonly sourceControlWritingStyle?: {
    readonly mode?: Wire148;
    readonly customInstructions?: string;
    readonly followChangeRequestTemplates?: boolean;
  };
  readonly sourceControlWriterModelSelection?: Wire3 | null;
  readonly reviewGuidesEnabled?: boolean;
  readonly reviewGuideModelSelection?: Wire3 | null;
  readonly reviewGuideInstructions?: string;
  readonly pullRequestMergeMethod?: Wire151 | null;
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
  readonly sourceControlHosts?: { readonly [x: string]: Wire166 };
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean };
  readonly providerInstances?: { readonly [x: string]: Wire165 };
  readonly usageLimitSources?: { readonly [x: string]: Wire167 | null };
  readonly textGenerators?: { readonly [x: string]: Wire168 | null };
  readonly secretProviders?: {
    readonly [x: string]: {
      readonly kind: string;
      readonly label: string;
      readonly config?: unknown;
    } | null;
  };
  readonly usageHistoryRetentionDays?: Wire169;
  readonly usagePriceOverrides?: { readonly [x: string]: Wire170 | null };
  readonly usageModelAliases?: { readonly [x: string]: string | null };
};
