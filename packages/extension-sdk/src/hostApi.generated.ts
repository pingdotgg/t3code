// Generated from T3 service schemas by apps/server/scripts/extensionHostApi.ts.
type Wire1 =
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
type Wire2 = string | undefined;
type Wire4 = unknown | undefined;
type Wire5 = "local" | "worktree";
type Wire6 = boolean | undefined;
type Wire8 = string | undefined;
type Wire10 = "user" | "agent" | "system";
type Wire11 = "web" | "mobile" | "mcp" | "provider" | "server";
type Wire12 = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
type Wire13 = "default" | "plan";
type Wire14 = {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
};
type Wire16 = "manual" | "created" | "agent" | "stack" | "stack-dismissed";
type Wire18 = "open" | "closed" | "merged";
type Wire19 = number | undefined;
type Wire24 = "native" | "v1_import" | undefined;
type Wire26 =
  | "read-only"
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access"
  | undefined;
type Wire27 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;
type Wire28 =
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
type Wire29 =
  | "usage_limit"
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";
type Wire31 = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
type Wire32 = "user" | "assistant" | "system";
type Wire34 = string | undefined;
type Wire35 = true | undefined;
type Wire38 = ReadonlyArray<string> | undefined;
type Wire39 =
  | {
      readonly openedAt: number;
      readonly score: number;
      readonly picks: ReadonlyArray<{ readonly query: string; readonly at: number }>;
    }
  | null
  | undefined;
type Wire41 = "renamed" | "unchanged" | "failed";
type Wire43 = {
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
              readonly root: Wire44;
            }
          | undefined;
        readonly appIdentifier?: string | undefined;
        readonly appIconDataUrl?: string | undefined;
      }
    | undefined;
};
type Wire45 = {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: { readonly _tag: "pasted-text" } | undefined;
};
type Wire46 = string | undefined;
type Wire49 = "strong" | "weak" | "none";
type Wire52 = string | undefined;
type Wire53 = number | undefined;
type Wire56 = ReadonlyArray<string> | undefined;
type Wire57 = { readonly inputTokens: number; readonly outputTokens: number } | undefined;
type Wire59 = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
type Wire61 = { readonly [x: string]: unknown };
type Wire65 = "completed" | "failed" | "cancelled" | "updated" | "unknown";
type Wire66 =
  | { readonly environmentId: string; readonly threadId: string; readonly title: string }
  | undefined;
type Wire67 = "beforeCacheExpires" | "onReturn" | undefined;
type Wire69 = string | null;
type Wire70 = "draft" | "active" | "completed" | "superseded";
type Wire71 = true | undefined;
type Wire74 = { readonly cursor: string; readonly itemCount: number; readonly lastOrdinal: number };
type Wire75 = "browser" | "computer" | undefined;
type Wire76 =
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
type Wire78 = string | null;
type Wire79 = string | null;
type Wire80 = string | null;
type Wire81 = string | null;
type Wire83 = string | null;
type Wire84 =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
type Wire85 = string | null;
type Wire86 = string | null;
type Wire87 = string | null;
type Wire101 = {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
};
type Wire102 = { readonly count: number; readonly additions: number; readonly deletions: number };
type Wire118 =
  | { readonly type: "latest_stable" }
  | { readonly type: "run"; readonly runId: string }
  | { readonly type: "checkpoint"; readonly checkpointId: string };
type Wire119 = ReadonlyArray<{ readonly provider: string; readonly model: string }>;
type Wire120 = {
  readonly [x: string]: {
    readonly hiddenModels?: ReadonlyArray<string> | undefined;
    readonly modelOrder?: ReadonlyArray<string> | undefined;
  };
};
type Wire123 = "any-local-files" | "uncommitted-changes" | "tracked-changes";
type Wire124 = number | null;
type Wire126 = number | null;
type Wire128 = "turn" | "paragraph";
type Wire131 = { readonly provider: string; readonly reference: string };
type Wire132 = "auto" | "cpu" | string;
type Wire133 = "never" | "immediately" | "min_2" | "min_5" | "min_10" | "min_15" | "hour_1";
type Wire134 = ReadonlyArray<{ readonly term: string; readonly aliases: ReadonlyArray<string> }>;
type Wire141 = "repo_conventions" | "conventional_commits" | "custom";
type Wire142 = "static" | "semantic" | "custom";
type Wire144 = "merge" | "squash" | "rebase" | "fast-forward";
type Wire145 = number | null;
type Wire146 = { readonly [x: string]: { readonly enabled?: boolean } };
type Wire151 = "onReturn" | "beforeCacheExpires" | "off";
type Wire152 =
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
type Wire153 = "balanced" | "performance" | "battery-saver" | "custom";
type Wire154 = "balanced" | "performance" | "battery-saver";
type Wire155 = {
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly hostPowerMonitorActiveInterval?: number;
  readonly hostPowerMonitorIdleInterval?: number;
  readonly pauseWhenHostLocked?: boolean;
  readonly pauseWhenHostLowPower?: boolean;
  readonly pauseWhenClientLowPower?: boolean;
  readonly pauseWhenOnBattery?: boolean;
};
type Wire156 = number | undefined;
type Wire158 = { readonly [x: string]: unknown };
type Wire161 = {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly cacheReadCostPerMillionTokens?: number;
  readonly cacheWriteCostPerMillionTokens?: number;
};
type Wire162 = ReadonlyArray<{ readonly term: string; readonly aliases: ReadonlyArray<string> }>;
type Wire3 = {
  readonly provider?: Wire4;
  readonly instanceId?: Wire4;
  readonly model: unknown;
  readonly options?: Wire4;
};
type Wire21 =
  | {
      readonly startedAt: string;
      readonly headSha: string | null;
      readonly failedChecks: ReadonlyArray<string>;
      readonly passed: boolean;
      readonly passedChecks?: ReadonlyArray<string> | undefined;
      readonly owedChecks?: ReadonlyArray<string> | undefined;
      readonly awaitingApproval?: ReadonlyArray<string> | undefined;
      readonly approvalAnnounced?: Wire6;
      readonly remarksThrough: string;
      readonly remarkIds: ReadonlyArray<string>;
      readonly conflicting: boolean;
      readonly mergeQueueRemovalId?: string | null | undefined;
      readonly wakes: number;
      readonly awaitingBaseline?: "all" | "checks" | undefined;
      readonly checksAwaitedSince?: string | null | undefined;
      readonly checksPending?: Wire6;
    }
  | undefined;
type Wire22 = {
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly rootThreadId: string;
  readonly sideChat?: Wire6;
};
type Wire7 = {
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
type Wire23 =
  | { readonly type: "run"; readonly threadId: string; readonly runId: string }
  | { readonly type: "node"; readonly nodeId: string }
  | {
      readonly type: "provider_thread";
      readonly providerThreadId: string;
      readonly providerTurnId?: Wire8;
    }
  | null;
type Wire37 = {
  readonly requestId?: Wire8;
  readonly runId: string;
  readonly resetAt: string;
  readonly autoResume: boolean;
  readonly snooze?: Wire6;
};
type Wire47 =
  | { readonly type: "root"; readonly branch?: Wire8 }
  | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch?: Wire8 }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: Wire8;
      readonly startFromOrigin?: Wire6;
    }
  | undefined;
type Wire68 =
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
      readonly records: ReadonlyArray<unknown>;
    }
  | undefined;
type Wire147 = ReadonlyArray<{
  readonly kind?: "ssh";
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly identityFile?: Wire8;
  readonly port?: number | undefined;
}>;
type Wire20 = {
  readonly kind: "native";
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly state: Wire18;
  }>;
};
type Wire17 = {
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
};
type Wire25 =
  | { readonly sessionId: string; readonly label: string; readonly access?: Wire26 }
  | undefined;
type Wire107 = {
  readonly class: Wire29;
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean | null;
  readonly resetAt?: string | null | undefined;
};
type Wire30 = Wire31 | "dynamic_tool_call" | "user_input" | "auth_refresh";
type Wire36 = {
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
  readonly lastCheck?: Wire34;
};
type Wire50 =
  | {
      readonly environmentId: string;
      readonly threadId: string;
      readonly label: string;
      readonly title?: Wire34;
      readonly runId?: Wire8;
      readonly stoppedThere?: Wire6;
      readonly stopCount?: Wire19;
    }
  | undefined;
type Wire72 = {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
  readonly durationAnchorAt?: Wire34;
  readonly durationMs?: Wire19;
};
type Wire33 =
  | {
      readonly command?: Wire34;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly awaited?: Wire35;
      readonly kind: "subagent";
      readonly providerInstanceId?: string | undefined;
      readonly childThreadId?: Wire8;
    }
  | {
      readonly command?: Wire34;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly awaited?: Wire35;
      readonly kind: "command";
    }
  | {
      readonly command?: Wire34;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly awaited?: Wire35;
      readonly kind: "monitor";
    }
  | {
      readonly command?: Wire34;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly awaited?: Wire35;
      readonly kind: "background_task";
    }
  | {
      readonly command?: Wire34;
      readonly itemId?: Wire8;
      readonly sourceThreadId?: Wire8;
      readonly taskId: string;
      readonly description?: Wire8;
      readonly parentTaskId?: Wire8;
      readonly nativeItemId?: Wire8;
      readonly awaited?: Wire35;
      readonly kind?: string | undefined;
    };
type Wire40 = {
  readonly status: Wire41;
  readonly message?: Wire34;
  readonly requestId: string;
  readonly completedAt: string;
};
type Wire42 =
  | Wire43
  | Wire45
  | {
      readonly type: string;
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    };
type Wire94 = { readonly [x: string]: ReadonlyArray<Wire43 | Wire45> };
type Wire48 = {
  readonly driver: string;
  readonly nativeId: string | null;
  readonly strength: Wire49;
  readonly fingerprint?: Wire8;
  readonly ordinal?: Wire19;
};
type Wire55 =
  | {
      readonly usedTokens: number;
      readonly maxTokens?: number | null | undefined;
      readonly inputTokens?: Wire19;
      readonly cachedInputTokens?: Wire19;
      readonly outputTokens?: Wire19;
      readonly reasoningOutputTokens?: Wire19;
      readonly promptCacheTtlMs?: Wire53;
      readonly autoCompactThreshold?: Wire53;
      readonly promptCacheExpiresAt?: Wire34;
      readonly updatedAt: string;
    }
  | undefined;
type Wire58 = Wire59 | undefined;
type Wire60 = Wire61 | undefined;
type Wire64 = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly watchStartedAt: string;
  readonly headSha: string | null;
  readonly watchEnded?: Wire6;
  readonly section?:
    | { readonly text: string; readonly outcome: Wire65; readonly summary: string }
    | undefined;
};
type Wire77 =
  | {
      readonly key: string;
      readonly name: string;
      readonly kind: "browser" | "computer" | "integration";
      readonly icon?: Wire76;
    }
  | undefined;
type Wire122 = Wire123 | undefined;
type Wire127 = Wire124 | undefined;
type Wire125 = Wire126 | undefined;
type Wire130 = string | Wire131;
type Wire157 = {
  readonly driver: string;
  readonly displayName?: Wire8;
  readonly accentColor?: Wire8;
  readonly environment?: ReadonlyArray<{
    readonly name: string;
    readonly value?: Wire34;
    readonly sensitive?: Wire6;
    readonly valueRedacted?: boolean;
    readonly secret?: Wire131;
  }>;
  readonly enabled?: boolean;
  readonly config?: unknown;
};
type Wire140 = {
  readonly mode?: Wire141 | undefined;
  readonly customInstructions?: Wire34;
  readonly followChangeRequestTemplates?: Wire6;
};
type Wire143 = Wire144 | null;
type Wire150 = boolean | Wire151;
type Wire51 = Wire3 | undefined;
type Wire135 = Wire3 | null;
type Wire137 = Wire3 | null;
type Wire138 = Wire3 | null;
type Wire136 = ReadonlyArray<Wire7>;
type Wire15 = {
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
type Wire82 = Wire48 | null;
type Wire117 = Wire48 | undefined;
type Wire63 =
  | {
      readonly kind: "delegated_task";
      readonly taskIds: ReadonlyArray<string>;
      readonly childThreadId?: Wire8;
    }
  | { readonly kind: "background_task"; readonly work: "subagent"; readonly childThreadId?: Wire8 }
  | { readonly kind: "background_command" }
  | { readonly kind: "subagent"; readonly childThreadId?: Wire8 }
  | { readonly kind: "command" }
  | {
      readonly kind: "monitor";
      readonly pullRequest?: Wire64 | undefined;
      readonly otherPullRequests?: ReadonlyArray<Wire64> | undefined;
    }
  | { readonly kind: "background_task" }
  | { readonly kind: "system" }
  | { readonly kind?: string | undefined };
type Wire121 =
  | { readonly mode: "off" }
  | {
      readonly mode: "custom";
      readonly rules: {
        readonly worktreeKeepWhen?: Wire122;
        readonly worktreeAfterDays: Wire124;
        readonly worktreeSettledAfterDays?: Wire125;
        readonly worktreeOnMerge: boolean;
        readonly worktreeOnDelete: boolean;
        readonly worktreeUnchanged: boolean;
      };
    }
  | null;
type Wire129 = Wire130 | undefined;
type Wire148 = ReadonlyArray<{
  readonly kind: "eas";
  readonly id: string;
  readonly label: string;
  readonly appId?: Wire8;
  readonly accessToken?: Wire130;
  readonly maxSessionMinutes?: number;
  readonly idleMinutes?: number;
  readonly maxConcurrentSessions?: number;
}>;
type Wire149 = ReadonlyArray<{
  readonly kind: "simlock";
  readonly id: string;
  readonly label: string;
  readonly gatewayUrl: string;
  readonly agentToken?: Wire130;
  readonly maxLeases?: number;
  readonly maxLeaseMinutes?: number;
}>;
type Wire139 = Wire140 | string;
type Wire54 = {
  readonly cursorStoreCwd?: Wire8;
  readonly modelSelection?: Wire51;
  readonly title?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly itemIdentityVersion?: 2 | undefined;
  readonly forkHeadMessageId?: Wire8;
  readonly claudeAttachmentBudget?:
    | { readonly bytesUsed: number; readonly pagesUsed: number }
    | undefined;
};
type Wire9 = {
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
  readonly pullRequests?: ReadonlyArray<Wire15> | undefined;
  readonly branchPullRequest?: Wire14 | null | undefined;
  readonly lineage: Wire22;
  readonly forkedFrom: Wire23 | null;
  readonly activeProviderThreadId: string | null;
  readonly historyOrigin?: Wire24;
  readonly linkOrigin?: Wire25;
  readonly delegatedFrom?: Wire27;
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
  readonly status: "idle" | Wire28;
  readonly lastError?: string | null | undefined;
  readonly lastErrorClass?: Wire29 | null | undefined;
  readonly lastErrorCode?: string | null | undefined;
  readonly usageLimitResetAt?: string | null | undefined;
  readonly pendingRuntimeRequest: {
    readonly id: string;
    readonly kind: Wire30;
    readonly createdAt: string;
    readonly blocking?: Wire6;
    readonly userOnly?: Wire6;
  } | null;
  readonly pendingGuestMessageCount?: Wire19;
  readonly latestVisibleMessage: {
    readonly id: string;
    readonly role: Wire32;
    readonly text: string;
    readonly updatedAt: string;
  } | null;
  readonly latestUserMessageAt: string | null;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks?: ReadonlyArray<Wire33> | undefined | undefined;
  readonly providerInstanceHistory?: ReadonlyArray<string> | undefined | undefined;
  readonly goal?: Wire36 | null | undefined;
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
  readonly limitRecovery?: Wire37 | null | undefined;
  readonly pinnedAt?: string | null | undefined;
  readonly autoSettleDisabledAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
  readonly tags?: Wire38;
  readonly lastVisitedAt?: string | null | undefined;
  readonly opens?: Wire39;
  readonly titleRegeneration?:
    | { readonly requestId: string; readonly startedAt: string }
    | null
    | undefined;
  readonly lastTitleRegeneration?: Wire40 | null | undefined;
  readonly deletedAt: string | null;
};
type Wire88 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly createdBy: Wire10;
  readonly creationSource: Wire11;
  readonly type: "user_message";
  readonly messageId: string;
  readonly scheduledTaskId?: Wire8;
  readonly senderThreadId?: Wire8;
  readonly linkedSender?: Wire66;
  readonly idleCompaction?: Wire67;
  readonly workflowScript?: Wire6;
  readonly freshContext?: Wire6;
  readonly inputIntent: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
  readonly text: string;
  readonly textOmitted?: true;
  readonly context?: Wire68;
  readonly attachments: ReadonlyArray<Wire42>;
  readonly modelSwitch?: { readonly from: Wire3; readonly to: Wire3 } | undefined;
};
type Wire89 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "assistant_message";
  readonly phase?: "commentary" | "partial_answer" | "final_answer" | undefined;
  readonly messageId: string;
  readonly text: string;
  readonly textOmitted?: true;
  readonly attachments?: ReadonlyArray<Wire42> | undefined;
  readonly streaming: boolean;
};
type Wire90 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "reasoning";
  readonly text: string;
  readonly streaming: boolean;
};
type Wire91 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "proposed_plan";
  readonly planId: string;
  readonly markdown: string;
  readonly streaming: boolean;
};
type Wire92 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "todo_list";
  readonly planId: string;
  readonly steps: ReadonlyArray<Wire72>;
  readonly explanation?: Wire34;
};
type Wire93 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "user_input_request";
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
      readonly value?: Wire34;
      readonly preview?: Wire34;
    }>;
    readonly multiSelect?: Wire6;
    readonly allowCustomAnswer?: Wire6;
    readonly initialAnswer?: Wire34;
    readonly required?: Wire6;
  }>;
  readonly questionAnswer?:
    | {
        readonly requestId: string;
        readonly questionTextById?: { readonly [x: string]: string } | undefined;
        readonly answers: Wire61;
        readonly attachmentsByQuestionId: Wire94;
      }
    | undefined;
  readonly responseMode?: "message" | undefined;
};
type Wire95 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "file_change";
  readonly fileName: string;
  readonly additions?: Wire19;
  readonly deletions?: Wire19;
  readonly diffStr?: Wire34;
  readonly oldStr?: Wire34;
  readonly newStr?: Wire34;
  readonly changes?:
    | ReadonlyArray<{
        readonly operation: string;
        readonly path: string;
        readonly oldPath?: Wire8;
        readonly fileType?: Wire8;
        readonly mimeType?: Wire8;
      }>
    | undefined;
};
type Wire96 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "command_execution";
  readonly input: string;
  readonly output?: Wire34;
  readonly outputOmitted?: Wire6;
  readonly outputIndicatesFailure?: Wire6;
  readonly exitCode?: number | undefined;
  readonly monitor?: Wire6;
  readonly completionWake?: "always" | undefined;
};
type Wire97 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "file_search";
  readonly pattern?: Wire34;
  readonly results?:
    | ReadonlyArray<{
        readonly fileName: string;
        readonly line?: Wire53;
        readonly column?: Wire53;
        readonly preview?: Wire34;
      }>
    | undefined;
};
type Wire98 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "web_search";
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly results?:
    | ReadonlyArray<{ readonly title?: Wire34; readonly url?: Wire8; readonly snippet?: Wire34 }>
    | undefined;
};
type Wire99 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "approval_request";
  readonly requestId: string;
  readonly requestKind: Wire31;
  readonly prompt?: Wire34;
  readonly reason?: Wire34;
  readonly fullAccessOverride?: "ask_rule" | "provider_check" | undefined;
  readonly appName?: Wire34;
  readonly options?:
    | ReadonlyArray<{ readonly decision: Wire59; readonly label: string; readonly warning?: Wire8 }>
    | undefined;
};
type Wire100 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "checkpoint";
  readonly checkpointId: string;
  readonly scopeId: string;
  readonly files: ReadonlyArray<Wire101>;
  readonly filesTotal?: Wire102;
  readonly filesOmitted?: true;
};
type Wire103 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "run_interrupt_request";
  readonly message: string;
  readonly unresponsiveAt?: string;
};
type Wire104 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "run_interrupt_result";
  readonly message: string;
};
type Wire105 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "system_notice";
  readonly message: string;
};
type Wire106 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "error";
  readonly failure: Wire107;
  readonly retry?:
    | {
        readonly attempt: number;
        readonly maxAttempts: number | null;
        readonly retryDelayMs: number | null;
      }
    | undefined;
};
type Wire108 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "compaction";
  readonly driver: string | null;
  readonly summary?: Wire34;
  readonly beforeTokenCount?: Wire19;
  readonly afterTokenCount?: Wire19;
};
type Wire109 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "handoff";
  readonly contextHandoffId: string;
  readonly fromProviderThreadIds: ReadonlyArray<string>;
  readonly toProviderThreadId: string;
  readonly fromProviderInstanceIds: ReadonlyArray<string>;
  readonly toProviderInstanceId: string;
  readonly fromModelSelections?: ReadonlyArray<Wire3> | undefined;
  readonly toModel?: Wire34;
  readonly strategy:
    | "delta_since_target_last_seen"
    | "fork_delta_summary"
    | "full_thread_summary"
    | "checkpoint_summary"
    | "manual_context";
  readonly summary?: Wire34;
};
type Wire110 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId?: Wire8;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
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
type Wire111 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "thread_created";
  readonly targetThreadId: string;
  readonly targetRunId: string | null;
  readonly targetProviderInstanceId: string;
  readonly targetModel: string;
};
type Wire112 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "secret_request";
  readonly label: string;
  readonly reason: string;
  readonly url?: Wire34;
  readonly placeholder?: Wire34;
  readonly delivery?: "file" | undefined;
  readonly secretStatus: "pending" | "saved" | "declined" | "cancelled";
};
type Wire113 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "link_request";
  readonly url?: Wire8;
  readonly reason: string;
  readonly environmentId?: Wire8;
  readonly label?: Wire34;
  readonly hint?: Wire34;
  readonly requestedAccess?: Wire26;
  readonly linkStatus: "pending" | "linked" | "declined" | "cancelled" | "failed";
  readonly linkedEnvironmentId?: Wire8;
  readonly linkedLabel?: Wire34;
  readonly linkedAccess?: Wire26;
  readonly failure?: Wire34;
};
type Wire114 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "subagent";
  readonly subagentId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly childThreadId: string | null;
  readonly remoteChild?: Wire50;
  readonly prompt: string;
  readonly progress?: Wire34;
  readonly result: string | null;
  readonly promptOmitted?: true;
  readonly resultOmitted?: true;
};
type Wire115 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "dynamic_tool";
  readonly toolName: string | null;
  readonly viewedImagePath?: Wire8;
  readonly input: unknown;
  readonly output?: Wire4;
  readonly outputOmitted?: Wire6;
};
type Wire116 = {
  readonly threadId: string;
  readonly runId?: Wire8;
  readonly checkpointId?: Wire8;
  readonly turnItemId?: Wire8;
  readonly providerThreadRef?: Wire117;
  readonly providerTurnRef?: Wire117;
};
type Wire62 =
  | {
      readonly source: Wire63;
      readonly outcome: Wire65;
      readonly summary: string;
      readonly detail?: Wire34;
    }
  | undefined;
type Wire73 = {
  readonly deferredWork?: Wire74;
  readonly toolNonExecutionKind?: Wire34;
  readonly toolSurface?: Wire75;
  readonly toolIcon?: Wire76;
  readonly toolSource?: Wire77;
  readonly id: string;
  readonly threadId: string;
  readonly runId: Wire78;
  readonly nodeId: Wire79;
  readonly providerThreadId: Wire80;
  readonly providerTurnId: Wire81;
  readonly nativeItemRef: Wire82;
  readonly parentItemId: Wire83;
  readonly ordinal: number;
  readonly status: Wire84;
  readonly title: Wire85;
  readonly startedAt: Wire86;
  readonly completedAt: Wire87;
  readonly updatedAt: string;
  readonly type: "notification";
  readonly source: Wire63;
  readonly outcome: Wire65;
  readonly summary: string;
  readonly detail?: Wire34;
};
type Wire159 = {
  readonly kind: "cliproxy";
  readonly label?: Wire8;
  readonly url: string;
  readonly managementKey?: Wire129;
  readonly enabled?: Wire6;
};
type Wire160 = {
  readonly kind: "openaiCompatible" | "anthropic";
  readonly label?: Wire8;
  readonly baseUrl: string;
  readonly apiKey?: Wire129;
  readonly enabled?: Wire6;
};
type Wire44 = {
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
  readonly actions?: ReadonlyArray<string>;
  readonly children: ReadonlyArray<Wire44>;
};
export type ProjectSnapshot = {
  readonly projects: ReadonlyArray<{
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
    readonly scripts: ReadonlyArray<Wire7>;
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
  readonly threads: ReadonlyArray<Wire9>;
  readonly archivedThreads: ReadonlyArray<Wire9>;
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
      readonly pullRequests?: ReadonlyArray<Wire15> | undefined;
      readonly branchPullRequest?: Wire14 | null | undefined;
      readonly activeProviderThreadId: string | null;
      readonly historyOrigin?: Wire24;
      readonly linkOrigin?: Wire25;
      readonly delegatedFrom?: Wire27;
      readonly lineage: Wire22;
      readonly forkedFrom: Wire23;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly archivedAt: string | null;
      readonly settledOverride?: "settled" | "active" | null | undefined;
      readonly settledAt?: string | null | undefined;
      readonly unsettledAt?: string | null | undefined;
      readonly snoozedUntil?: string | null | undefined;
      readonly snoozedAt?: string | null | undefined;
      readonly lastSnoozeWakeAt?: string | null | undefined;
      readonly limitRecovery?: Wire37 | null | undefined;
      readonly guestShare?:
        | {
            readonly id: string;
            readonly host: string;
            readonly createdAt: string;
            readonly expiresAt: string;
            readonly guestName: string | null;
            readonly messages: ReadonlyArray<{
              readonly id: string;
              readonly text: string;
              readonly status: "pending" | "sent" | "dismissed";
              readonly submittedAt: string;
              readonly attachments?: ReadonlyArray<Wire42> | undefined;
            }>;
          }
        | null
        | undefined;
      readonly pinnedAt?: string | null | undefined;
      readonly autoSettleDisabledAt?: string | null | undefined;
      readonly pinOrderKey?: string | null | undefined;
      readonly activeOrderKey?: string | null | undefined;
      readonly tags?: Wire38;
      readonly lastVisitedAt?: string | null | undefined;
      readonly opens?: Wire39;
      readonly titleRegeneration?:
        | { readonly requestId: string; readonly startedAt: string }
        | null
        | undefined;
      readonly lastTitleRegeneration?: Wire40 | null | undefined;
      readonly rollbackRequestId?: Wire8;
      readonly rollbackFailure?:
        | { readonly requestId: string; readonly message: string }
        | null
        | undefined;
      readonly deletedAt: string | null;
    };
    readonly runs: ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly ordinal: number;
      readonly providerInstanceId: string;
      readonly modelSelection: Wire3;
      readonly providerThreadId: string | null;
      readonly userMessageId: string;
      readonly rootNodeId: string | null;
      readonly activeAttemptId: string | null;
      readonly status: Wire28;
      readonly queuePosition?: number | null | undefined;
      readonly queueHeld?: Wire6;
      readonly steerWhenReadyRunId?: Wire8;
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly checkpointId: string | null;
      readonly contextHandoffId: string | null;
      readonly restartContinuationOfRunId?: Wire8;
      readonly usageLimitContinuationOfRunId?: Wire8;
      readonly delegatedTaskId?: Wire8;
      readonly workStartedAt?: Wire46;
      readonly restartCancelledBackgroundWork?:
        | ReadonlyArray<{
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
              readonly taskIds: ReadonlyArray<string>;
            } | null;
          }
        | undefined;
      readonly workspacePreparation?: Wire47;
      readonly freshContext?: Wire6;
    }>;
    readonly attempts: ReadonlyArray<{
      readonly id: string;
      readonly nativeThreadId?: Wire34;
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
    readonly nodes: ReadonlyArray<{
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
      readonly nativeItemRef: Wire48 | null;
      readonly runtimeRequestId: string | null;
      readonly checkpointScopeId: string | null;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    }>;
    readonly subagents: ReadonlyArray<{
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
      readonly remoteChild?: Wire50;
      readonly nativeTaskRef: Wire48 | null;
      readonly prompt: string;
      readonly title: string | null;
      readonly model: string | null;
      readonly modelSelection?: Wire51;
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
      readonly progress?: Wire34;
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
            readonly phases: ReadonlyArray<{ readonly index: number; readonly title: string }>;
            readonly agents: ReadonlyArray<{
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
              readonly prompt?: Wire52;
              readonly result?: Wire52;
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
    readonly providerSessions: ReadonlyArray<{
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
          readonly canForkFromSubagentThread: boolean;
          readonly exposesNativeThreadId: boolean;
        };
        readonly turns: {
          readonly supportsNativeGoals?: Wire6;
          readonly exposesNativeTurnId: boolean;
          readonly emitsTurnStarted: boolean;
          readonly emitsTurnCompleted: boolean;
          readonly supportsInterrupt: boolean;
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
          readonly nativeThreadIds: Wire49;
          readonly nativeTurnIds: Wire49;
          readonly nativeItemIds: Wire49;
          readonly nativeRequestIds: Wire49;
        };
        readonly runtimePolicy?: { readonly enforcement: "native" | "client-boundary" } | undefined;
      };
      readonly extensionStatuses?:
        | ReadonlyArray<{ readonly key: string; readonly text: string }>
        | undefined
        | undefined;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly lastError: string | null;
    }>;
    readonly providerThreads: ReadonlyArray<{
      readonly id: string;
      readonly driver: string;
      readonly providerInstanceId: string;
      readonly providerSessionId: string | null;
      readonly appThreadId: string | null;
      readonly ownerNodeId: string | null;
      readonly nativeThreadRef: Wire48 | null;
      readonly nativeConversationHeadRef: Wire48 | null;
      readonly status: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
      readonly firstRunOrdinal: number | null;
      readonly lastRunOrdinal: number | null;
      readonly handoffIds: ReadonlyArray<string>;
      readonly forkedFrom: {
        readonly providerThreadId: string;
        readonly providerTurnId?: Wire8;
        readonly checkpointId?: Wire8;
      } | null;
      readonly pendingBackgroundTasks?: ReadonlyArray<Wire33> | undefined | undefined;
      readonly contextUsage?:
        | {
            readonly usedTokens: number;
            readonly totalProcessedTokens?: Wire19;
            readonly maxTokens?: Wire53;
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
            readonly autoCompactThreshold?: Wire53;
            readonly cost?: { readonly amount: number; readonly currency: string } | undefined;
          }
        | null
        | undefined
        | undefined;
      readonly nativeMetadata?: Wire54 | null | undefined | undefined;
      readonly goal?: Wire36 | null | undefined | undefined;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly providerTurns: ReadonlyArray<{
      readonly id: string;
      readonly providerThreadId: string;
      readonly nodeId: string;
      readonly runAttemptId: string | null;
      readonly nativeTurnRef: Wire48 | null;
      readonly ordinal: number;
      readonly status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly tokenUsage?: Wire55;
      readonly turnTokenUsage?:
        | {
            readonly usageScope: "main_agent";
            readonly cachedInputTokens?: Wire19;
            readonly cacheCreationTokens?: Wire19;
            readonly reasoningTokens?: Wire19;
            readonly hasSubagents: boolean;
            readonly models?: Wire56;
            readonly localCommand?: Wire6;
            readonly otherUsage?: Wire57;
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
            readonly models?: Wire56;
            readonly localCommand?: Wire6;
            readonly otherUsage?: Wire57;
            readonly usageStatus: "partial" | "unavailable";
            readonly inputTokens?: Wire19;
            readonly outputTokens?: Wire19;
          }
        | undefined;
      readonly model?: Wire8;
    }>;
    readonly runtimeRequests: ReadonlyArray<{
      readonly id: string;
      readonly nodeId: string;
      readonly providerTurnId: string | null;
      readonly nativeRequestRef: Wire48 | null;
      readonly kind: Wire30;
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
      readonly decision?: Wire58;
      readonly feedback?: Wire34;
      readonly answers?: Wire60;
    }>;
    readonly messages: ReadonlyArray<{
      readonly notification?: Wire62;
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly scheduledTaskId?: Wire8;
      readonly senderThreadId?: Wire8;
      readonly linkedSender?: Wire66;
      readonly idleCompaction?: Wire67;
      readonly workflowScript?: Wire6;
      readonly id: string;
      readonly threadId: string;
      readonly runId: string | null;
      readonly nodeId: string | null;
      readonly role: Wire32;
      readonly text: string;
      readonly context?: Wire68;
      readonly attachments: ReadonlyArray<Wire42>;
      readonly streaming: boolean;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly delegatedCompletion?:
        | {
            readonly parentRunId: string;
            readonly generation: number;
            readonly taskIds: ReadonlyArray<string>;
          }
        | undefined;
    }>;
    readonly plans: ReadonlyArray<
      | {
          readonly id: string;
          readonly threadId: string;
          readonly runId: Wire69;
          readonly nodeId: string;
          readonly status: Wire70;
          readonly detailInTurnItem?: Wire71;
          readonly kind: "proposed_plan";
          readonly markdown: string;
        }
      | {
          readonly id: string;
          readonly threadId: string;
          readonly runId: Wire69;
          readonly nodeId: string;
          readonly status: Wire70;
          readonly detailInTurnItem?: Wire71;
          readonly kind: "todo_list";
          readonly steps: ReadonlyArray<Wire72>;
          readonly explanation?: Wire34;
        }
    >;
    readonly turnItems: ReadonlyArray<
      | Wire73
      | Wire88
      | Wire89
      | Wire90
      | Wire91
      | Wire92
      | Wire93
      | Wire95
      | Wire96
      | Wire97
      | Wire98
      | Wire99
      | Wire100
      | Wire103
      | Wire104
      | Wire105
      | Wire106
      | Wire108
      | Wire109
      | Wire110
      | Wire111
      | Wire112
      | Wire113
      | Wire114
      | Wire115
      | { readonly type: string }
    >;
    readonly checkpointScopes: ReadonlyArray<{
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
      readonly createdAt: string;
    }>;
    readonly checkpoints: ReadonlyArray<{
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
      readonly files: ReadonlyArray<Wire101>;
      readonly filesTotal?: Wire102;
      readonly capturedAt: string;
    }>;
    readonly contextHandoffs: ReadonlyArray<{
      readonly id: string;
      readonly transferId?: string | null | undefined;
      readonly threadId: string;
      readonly targetRunId: string;
      readonly fromProviderThreadIds: ReadonlyArray<string>;
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
            readonly messages: ReadonlyArray<{
              readonly role: "user" | "assistant";
              readonly text: string;
              readonly runStatus?: Wire34;
              readonly threadId: string;
              readonly runId: string | null;
              readonly itemId: string;
              readonly providerThreadId: string | null;
              readonly status: string;
              readonly kind: string;
            }>;
            readonly coverage: string;
            readonly omittedItems: number;
            readonly omittedItemIds?: ReadonlyArray<string> | undefined;
          }
        | undefined;
      readonly delivery?:
        | {
            readonly nativeThreadId: string;
            readonly status: "pending" | "injected" | "inline";
            readonly itemIds: ReadonlyArray<string>;
            readonly omittedItemIds?: ReadonlyArray<string> | undefined;
          }
        | undefined;
      readonly detailInTurnItem?: true | undefined;
      readonly createdByProviderInstanceId: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>;
    readonly contextTransfers: ReadonlyArray<{
      readonly id: string;
      readonly type:
        | "fork"
        | "provider_handoff"
        | "merge_back"
        | "subagent_spawn"
        | "subagent_result";
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire116;
      readonly basePoint: Wire116 | null;
      readonly sourceProviderInstanceId: string | null;
      readonly sourceTokenUsage?: Wire55;
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
        | { readonly strategy: "native_fork"; readonly providerThreadRef: Wire48 }
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
    readonly visibleTurnItems: ReadonlyArray<{
      readonly position: number;
      readonly visibility: "local" | "inherited" | "synthetic";
      readonly sourceThreadId: string;
      readonly sourceItemId: string;
      readonly item:
        | Wire73
        | Wire88
        | Wire89
        | Wire90
        | Wire91
        | Wire92
        | Wire93
        | Wire95
        | Wire96
        | Wire97
        | Wire98
        | Wire99
        | Wire100
        | Wire103
        | Wire104
        | Wire105
        | Wire106
        | Wire108
        | Wire109
        | Wire110
        | Wire111
        | Wire112
        | Wire113
        | Wire114
        | Wire115
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
      readonly reason?: Wire34;
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
      readonly modelSelection: Wire3;
      readonly runtimeMode: Wire12;
      readonly interactionMode: Wire13;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly linkOrigin?: Wire25;
      readonly delegatedFrom?: Wire27;
      readonly importedNativeThread?:
        | {
            readonly ref: {
              readonly driver: string;
              readonly nativeId: string;
              readonly strength: "strong";
            };
            readonly metadata?: Wire54 | undefined;
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
      readonly settledAt?: Wire46;
    }
  | {
      readonly type: "thread.auto-settle";
      readonly commandId: string;
      readonly threadId: string;
      readonly snapshotAt: string;
      readonly settledAt?: Wire46;
    }
  | {
      readonly type: "thread.unsettle";
      readonly commandId: string;
      readonly threadId: string;
      readonly reason: "user";
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
      readonly type: "thread.pull-request.watch";
      readonly commandId: string;
      readonly threadId: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly watching: boolean;
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
      readonly outcome?: { readonly status: Wire41; readonly message?: Wire34 } | undefined;
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
      readonly reason?: Wire34;
    }
  | {
      readonly type: "message.dispatch";
      readonly notification?: Wire62;
      readonly guestMessageId?: Wire8;
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly scheduledTaskId?: Wire8;
      readonly senderThreadId?: Wire8;
      readonly linkedSender?: Wire66;
      readonly idleCompaction?: Wire67;
      readonly freshContext?: Wire6;
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string;
      readonly context?: Wire68;
      readonly attachments: ReadonlyArray<Wire42>;
      readonly titleSeed?: Wire8;
      readonly modelSelection?: Wire51;
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
            readonly taskIds: ReadonlyArray<string>;
          }
        | undefined;
      readonly dispatchMode:
        | { readonly type: "defer_start"; readonly workspaceStrategy?: Wire47 }
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
      readonly failure: Wire107;
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
      readonly reason?: Wire34;
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
      readonly context?: Wire68;
      readonly commandId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly text: string;
      readonly attachments?: ReadonlyArray<Wire42> | undefined;
    }
  | {
      readonly type: "runtime-request.respond";
      readonly commandId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision?: Wire58;
      readonly feedback?: Wire34;
      readonly answers?: Wire60;
      readonly attachmentsByQuestionId?: Wire94 | undefined;
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
      readonly sourcePoint: Wire118;
      readonly title?: Wire8;
      readonly sideChat?: Wire6;
      readonly createdAt?: Wire46;
    }
  | {
      readonly type: "thread.merge_back";
      readonly createdBy: Wire10;
      readonly creationSource: Wire11;
      readonly commandId: string;
      readonly sourceThreadId: string;
      readonly targetThreadId: string;
      readonly sourcePoint: Wire118;
      readonly createdAt?: Wire46;
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
      readonly workspaceStrategy?: Wire47;
      readonly completionWake?: "always" | "settled_only" | undefined;
      readonly createdAt?: Wire46;
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
  readonly favorites?: Wire119 | null | undefined;
  readonly providerModelPreferences?: Wire120 | null | undefined;
  readonly worktreeCleanup?: Wire121 | undefined;
  readonly storageCleanup?:
    | {
        readonly worktreeKeepWhen?: Wire122;
        readonly worktreeAfterDays?: Wire127;
        readonly worktreeSettledAfterDays?: Wire125;
        readonly worktreeOnMerge?: Wire6;
        readonly worktreeOnDelete?: Wire6;
        readonly worktreeUnchanged?: Wire6;
        readonly browserArtifactsAfterDays?: Wire127;
        readonly logsAfterDays?: Wire127;
      }
    | undefined;
  readonly worktreesDirectory?: Wire34;
  readonly fastWorktreeCheckout?: Wire6;
  readonly previousWorktreesDirectories?: ReadonlyArray<string> | undefined;
  readonly responseStreamingMode?: Wire128 | undefined;
  readonly enableProviderUpdateChecks?: Wire6;
  readonly continueThreadsAfterServerUpdate?: Wire6;
  readonly keepAwakeWhileAgentsWork?: Wire6;
  readonly enableAgentBrowserAccess?: Wire6;
  readonly cloudSpeechCredentials?:
    | { readonly openai?: Wire129; readonly xai?: Wire129; readonly openrouter?: Wire129 }
    | undefined;
  readonly speechModelId?: Wire34;
  readonly speechAcceleration?: Wire132 | undefined;
  readonly speechModelUnloadTimeout?: Wire133 | undefined;
  readonly speechProjectCustomWords?: Wire134 | undefined;
  readonly speechPostProcessingModelSelection?: Wire3 | null | undefined;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultAutoPull?: Wire6;
  readonly defaultProjectScripts?: ReadonlyArray<Wire7> | undefined;
  readonly projectScriptOverrides?:
    | { readonly [x: string]: ReadonlyArray<Wire7> | null }
    | undefined;
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean } | undefined;
  readonly defaultModelSelection?: Wire3 | null | undefined;
  readonly fallbackModelSelection?: Wire3 | null | undefined;
  readonly defaultRuntimeMode?: Wire12 | undefined;
  readonly projectSettingsOverrides?:
    | {
        readonly [x: string]: {
          readonly worktreeCleanup?: Wire121;
          readonly defaultModelSelection?: Wire135;
          readonly defaultRuntimeMode?: Wire12;
          readonly defaultThreadEnvMode?: Wire5;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire136;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire137;
          readonly reviewGuideModelSelection?: Wire138;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire139;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire142;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire143;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire145;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire128;
          readonly speechProjectCustomWords?: Wire134;
          readonly providerInstances?: Wire146;
        } & { readonly [x: string]: unknown };
      }
    | undefined;
  readonly projectSettingsFolded?: Wire6;
  readonly enableAgentDeviceAccess?: Wire6;
  readonly enableDeviceSupport?: Wire6;
  readonly deviceOnboardingCompleted?: Wire6;
  readonly deviceHosts?: Wire147 | undefined;
  readonly easDeviceHosts?: Wire148 | undefined;
  readonly simlockDeviceHosts?: Wire149 | undefined;
  readonly simlockDeviceHostsEnabled?: Wire6;
  readonly sidebarAutoSettleAfterDays?: number | null | undefined;
  readonly compactIdleThreads?: Wire150 | undefined;
  readonly idleCompaction?: Wire151;
  readonly snoozeLimitedThreads?: Wire6;
  readonly autoResumeLimitedThreads?: Wire6;
  readonly snoozePresets?: ReadonlyArray<Wire152> | undefined;
  readonly hiddenThreadTags?: ReadonlyArray<unknown> | undefined;
  readonly hideTaggedThreads?: Wire6;
  readonly guestSharingEnabled?: Wire6;
  readonly linkedEnvironmentsEnabled?: Wire6;
  readonly promptSuggestionsEnabled?: Wire6;
  readonly sidebarAutoSettleKeepPullRequests?: Wire6;
  readonly sidebarAutoSettleOnMerge?: Wire6;
  readonly backgroundActivity?:
    | {
        readonly schemaVersion?: 1 | undefined;
        readonly profile?: Wire153 | undefined;
        readonly baseProfile?: Wire154;
        readonly overrides?: Wire155 | undefined;
      }
    | undefined;
  readonly automaticGitFetchInterval?: Wire156;
  readonly providerHealthRefreshInterval?: Wire156;
  readonly backgroundActivityProfile?: Wire154 | undefined;
  readonly defaultTheme?: string | undefined;
  readonly defaultThemeSetAt?: string | undefined;
  readonly environmentIcon?: Wire4;
  readonly defaultThreadEnvMode?: unknown;
  readonly newWorktreesStartFromOrigin?: Wire6;
  readonly worktreeSubmodules?: Wire4;
  readonly addProjectBaseDirectory?: Wire34;
  readonly ghqCloneLayout?: Wire6;
  readonly textGenerationModelSelection?: Wire3 | undefined;
  readonly threadTitleInstructions?: Wire34;
  readonly branchNamingMode?: Wire142 | undefined;
  readonly branchNamePrefix?: Wire34;
  readonly branchNameInstructions?: Wire34;
  readonly removeAgentCreditsOnMerge?: Wire6;
  readonly sourceControlWritingStyle?: Wire139 | undefined;
  readonly sourceControlWriterModelSelection?: Wire3 | null | undefined;
  readonly reviewGuidesEnabled?: Wire6;
  readonly reviewGuideModelSelection?: Wire3 | null | undefined;
  readonly reviewGuideInstructions?: Wire34;
  readonly pullRequestMergeMethod?: Wire144 | null | undefined;
  readonly providerInstances?: { readonly [x: string]: Wire157 } | undefined;
  readonly observability?:
    | {
        readonly otlpTracesUrl?: Wire34;
        readonly otlpMetricsUrl?: Wire34;
        readonly otlpLogsUrl?: Wire34;
      }
    | undefined;
  readonly sourceControlHosts?: { readonly [x: string]: Wire158 } | undefined;
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean } | undefined;
  readonly usageLimitSources?: { readonly [x: string]: Wire159 } | undefined;
  readonly textGenerators?: { readonly [x: string]: Wire160 } | undefined;
  readonly secretProviders?:
    | {
        readonly [x: string]: {
          readonly kind: string;
          readonly label: string;
          readonly config?: unknown;
        };
      }
    | undefined;
  readonly usagePriceOverrides?: { readonly [x: string]: Wire161 } | undefined;
  readonly usageModelAliases?: { readonly [x: string]: string } | undefined;
  readonly usageModelFilter?: unknown;
};
export type ServerSettingsPatch = {
  readonly setModelFavorites?: ReadonlyArray<{
    readonly provider: string;
    readonly model: string;
    readonly favorite: boolean;
  }>;
  readonly setModelsHidden?: ReadonlyArray<{
    readonly provider: string;
    readonly model: string;
    readonly hidden: boolean;
  }>;
  readonly setProviderModelOrder?: {
    readonly provider: string;
    readonly modelOrder: ReadonlyArray<string>;
  };
  readonly favorites?: Wire119;
  readonly providerModelPreferences?: Wire120;
  readonly migrateModelPreferences?: {
    readonly favorites?: Wire119;
    readonly providerModelPreferences?: Wire120;
  };
  readonly worktreeCleanup?:
    | { readonly mode: "off" }
    | {
        readonly mode: "custom";
        readonly rules: {
          readonly worktreeKeepWhen?: Wire123;
          readonly worktreeAfterDays?: Wire124;
          readonly worktreeSettledAfterDays?: Wire126;
          readonly worktreeOnMerge?: boolean;
          readonly worktreeOnDelete?: boolean;
          readonly worktreeUnchanged?: boolean;
        };
      }
    | null;
  readonly storageCleanup?: {
    readonly worktreeKeepWhen?: Wire123;
    readonly worktreeAfterDays?: Wire124;
    readonly worktreeSettledAfterDays?: Wire126;
    readonly worktreeOnMerge?: boolean;
    readonly worktreeOnDelete?: boolean;
    readonly worktreeUnchanged?: boolean;
    readonly browserArtifactsAfterDays?: Wire124;
    readonly logsAfterDays?: Wire124;
  };
  readonly worktreesDirectory?: string;
  readonly fastWorktreeCheckout?: boolean;
  readonly responseStreamingMode?: Wire128;
  readonly enableProviderUpdateChecks?: boolean;
  readonly continueThreadsAfterServerUpdate?: boolean;
  readonly keepAwakeWhileAgentsWork?: boolean;
  readonly enableAgentBrowserAccess?: boolean;
  readonly cloudSpeechCredentials?: {
    readonly openai?: Wire130;
    readonly xai?: Wire130;
    readonly openrouter?: Wire130;
  };
  readonly speechModelId?: string;
  readonly speechAcceleration?: Wire132;
  readonly speechModelUnloadTimeout?: Wire133;
  readonly speechProjectCustomWords?: Wire162;
  readonly speechPostProcessingModelSelection?: Wire3 | null;
  readonly projectAgentBrowserAccessOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultAutoPull?: boolean;
  readonly defaultProjectScripts?: ReadonlyArray<Wire7>;
  readonly projectScriptOverrides?: { readonly [x: string]: ReadonlyArray<Wire7> | null };
  readonly projectAutoPullOverrides?: { readonly [x: string]: boolean | null };
  readonly defaultModelSelection?: Wire3 | null;
  readonly defaultRuntimeMode?: Wire12;
  readonly fallbackModelSelection?: Wire3 | null;
  readonly projectSettingsOverrides?: {
    readonly [x: string]:
      | ({
          readonly worktreeCleanup?: Wire121;
          readonly defaultModelSelection?: Wire135;
          readonly defaultRuntimeMode?: Wire12;
          readonly defaultThreadEnvMode?: Wire5;
          readonly newWorktreesStartFromOrigin?: boolean;
          readonly worktreeSubmodules?: unknown;
          readonly defaultAutoPull?: boolean;
          readonly defaultProjectScripts?: Wire136;
          readonly enableAgentBrowserAccess?: boolean;
          readonly enableAgentDeviceAccess?: boolean;
          readonly textGenerationModelSelection?: Wire3;
          readonly threadTitleInstructions?: string;
          readonly sourceControlWriterModelSelection?: Wire137;
          readonly reviewGuideModelSelection?: Wire138;
          readonly reviewGuideInstructions?: string;
          readonly sourceControlWritingStyle?: Wire140;
          readonly removeAgentCreditsOnMerge?: boolean;
          readonly branchNamingMode?: Wire142;
          readonly branchNamePrefix?: string;
          readonly branchNameInstructions?: string;
          readonly pullRequestMergeMethod?: Wire143;
          readonly sidebarAutoSettleOnMerge?: boolean;
          readonly sidebarAutoSettleAfterDays?: Wire145;
          readonly sidebarAutoSettleKeepPullRequests?: boolean;
          readonly continueThreadsAfterServerUpdate?: boolean;
          readonly responseStreamingMode?: Wire128;
          readonly speechProjectCustomWords?: Wire162;
          readonly providerInstances?: Wire146;
        } & { readonly [x: string]: unknown })
      | null;
  };
  readonly enableAgentDeviceAccess?: boolean;
  readonly enableDeviceSupport?: boolean;
  readonly deviceOnboardingCompleted?: boolean;
  readonly deviceHosts?: Wire147;
  readonly easDeviceHosts?: Wire148;
  readonly simlockDeviceHosts?: Wire149;
  readonly simlockDeviceHostsEnabled?: boolean;
  readonly sidebarAutoSettleAfterDays?: number | null;
  readonly compactIdleThreads?: Wire150;
  readonly idleCompaction?: Wire151;
  readonly sidebarAutoSettleKeepPullRequests?: boolean;
  readonly sidebarAutoSettleOnMerge?: boolean;
  readonly autoResumeLimitedThreads?: boolean;
  readonly snoozeLimitedThreads?: boolean;
  readonly snoozePresets?: ReadonlyArray<Wire152>;
  readonly hiddenThreadTags?: ReadonlyArray<string>;
  readonly hideTaggedThreads?: boolean;
  readonly guestSharingEnabled?: boolean;
  readonly linkedEnvironmentsEnabled?: boolean;
  readonly promptSuggestionsEnabled?: boolean;
  readonly backgroundActivity?: {
    readonly schemaVersion?: 1;
    readonly profile?: Wire153;
    readonly baseProfile?: Wire154;
    readonly overrides?: Wire155;
  };
  readonly automaticGitFetchInterval?: number;
  readonly providerHealthRefreshInterval?: number;
  readonly backgroundActivityProfile?: Wire154;
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
      | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
      | { readonly [x: string]: unknown };
  };
  readonly threadTitleInstructions?: string;
  readonly branchNamingMode?: Wire142;
  readonly branchNamePrefix?: string;
  readonly branchNameInstructions?: string;
  readonly removeAgentCreditsOnMerge?: boolean;
  readonly sourceControlWritingStyle?: {
    readonly mode?: Wire141;
    readonly customInstructions?: string;
    readonly followChangeRequestTemplates?: boolean;
  };
  readonly sourceControlWriterModelSelection?: Wire3 | null;
  readonly reviewGuidesEnabled?: boolean;
  readonly reviewGuideModelSelection?: Wire3 | null;
  readonly reviewGuideInstructions?: string;
  readonly pullRequestMergeMethod?: Wire144 | null;
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
  readonly sourceControlHosts?: { readonly [x: string]: Wire158 };
  readonly offeredSourceControlProviders?: { readonly [x: string]: boolean };
  readonly providerInstances?: { readonly [x: string]: Wire157 };
  readonly usageLimitSources?: { readonly [x: string]: Wire159 | null };
  readonly textGenerators?: { readonly [x: string]: Wire160 | null };
  readonly secretProviders?: {
    readonly [x: string]: {
      readonly kind: string;
      readonly label: string;
      readonly config?: unknown;
    } | null;
  };
  readonly usagePriceOverrides?: { readonly [x: string]: Wire161 | null };
  readonly usageModelAliases?: { readonly [x: string]: string | null };
};
