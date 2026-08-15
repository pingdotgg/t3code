import {
  ExecutionEnvironmentDescriptor,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  ReviewDiffPreviewResult,
  ServerConfig,
  ThreadTurnDiff,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { demoServerVersion } from "./stage";

export const DEMO_ENVIRONMENT_ID = "demo-environment";
export const DEMO_ENVIRONMENT_LABEL = "MacBook Pro";
export const DEMO_METRICS_WORKTREE_PATH = "~/code/mobile-app-worktrees/crash-dashboard";

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

/** Sentinel wake time for "permanently" snoozed demo threads. */
const SNOOZE_FOREVER = "2099-01-01T09:00:00.000Z";
const decodeShellSnapshotValue = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const decodeServerConfigValue = Schema.decodeUnknownSync(ServerConfig);
const decodeEnvironmentDescriptorValue = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeEnvironmentDescriptorValue = Schema.encodeSync(ExecutionEnvironmentDescriptor);

// ---------------------------------------------------------------------------
// Providers (shared across demo environments)
// ---------------------------------------------------------------------------

const demoProviders = [
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.52.0",
    status: "ready",
    auth: { status: "authenticated", label: "ChatGPT" },
    checkedAt: minutesAgo(1),
    models: [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex", isCustom: false, capabilities: null },
      { slug: "gpt-5.3", name: "GPT-5.3", isCustom: false, capabilities: null },
    ],
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude Code",
    enabled: true,
    installed: true,
    version: "2.3.0",
    status: "ready",
    auth: { status: "authenticated", label: "API key" },
    checkedAt: minutesAgo(1),
    models: [
      { slug: "claude-opus-5", name: "Opus 5", isCustom: false, capabilities: null },
      { slug: "claude-fable-5", name: "Fable 5", isCustom: false, capabilities: null },
      { slug: "claude-opus-4-8", name: "Opus 4.8", isCustom: false, capabilities: null },
      { slug: "claude-sonnet-5", name: "Sonnet 5", isCustom: false, capabilities: null },
      { slug: "claude-haiku-4-5", name: "Haiku 4.5", isCustom: false, capabilities: null },
    ],
  },
  {
    instanceId: "grok",
    driver: "grok",
    displayName: "Grok",
    enabled: true,
    installed: true,
    version: "1.8.0",
    status: "ready",
    auth: { status: "authenticated", label: "xAI" },
    checkedAt: minutesAgo(1),
    models: [
      { slug: "grok-code-fast-2", name: "Grok Code Fast 2", isCustom: false, capabilities: null },
      { slug: "grok-5", name: "Grok 5", isCustom: false, capabilities: null },
    ],
  },
  {
    instanceId: "opencode",
    driver: "opencode",
    displayName: "OpenCode",
    enabled: true,
    installed: true,
    version: "0.16.2",
    status: "ready",
    auth: { status: "authenticated", label: "OpenCode Zen" },
    checkedAt: minutesAgo(1),
    models: [
      { slug: "kimi-k2-thinking", name: "Kimi K2 Thinking", isCustom: false, capabilities: null },
      { slug: "glm-5", name: "GLM-5", isCustom: false, capabilities: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Thread + project fixture builders
// ---------------------------------------------------------------------------

interface DemoThreadSpec {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly model: string;
  readonly instanceId?: string;
  readonly branch: string | null;
  readonly createdMinutesAgo: number;
  readonly updatedMinutesAgo: number;
  readonly turn?: {
    readonly id?: string;
    readonly state: "running" | "completed" | "interrupted" | "error";
    readonly startedMinutesAgo?: number;
    readonly completedMinutesAgo?: number;
  };
  readonly sessionStatus?: "running" | "ready" | "idle";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  /** Marks the thread as explicitly settled this many minutes ago. */
  readonly settledMinutesAgo?: number;
  /** Snoozes the thread until the far-future sentinel ("permanently"). */
  readonly snoozedForever?: boolean;
  /** Worktree checkout the thread's git status is read from. */
  readonly worktreePath?: string;
}

function demoThread(spec: DemoThreadSpec) {
  const updatedAt = minutesAgo(spec.updatedMinutesAgo);
  const turnId = spec.turn?.id ?? `${spec.id}-turn-1`;
  return {
    id: spec.id,
    projectId: spec.projectId,
    title: spec.title,
    modelSelection: { instanceId: spec.instanceId ?? "codex", model: spec.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: spec.branch,
    worktreePath: spec.worktreePath ?? null,
    latestTurn: spec.turn
      ? {
          turnId,
          state: spec.turn.state,
          requestedAt: minutesAgo(spec.turn.startedMinutesAgo ?? spec.updatedMinutesAgo),
          startedAt: minutesAgo(spec.turn.startedMinutesAgo ?? spec.updatedMinutesAgo),
          completedAt:
            spec.turn.state === "running"
              ? null
              : minutesAgo(spec.turn.completedMinutesAgo ?? spec.updatedMinutesAgo),
          assistantMessageId: null,
        }
      : null,
    createdAt: minutesAgo(spec.createdMinutesAgo),
    updatedAt,
    archivedAt: null,
    session: spec.sessionStatus
      ? {
          threadId: spec.id,
          status: spec.sessionStatus,
          // The wire providerName is the driver kind slug, not a display name.
          providerName: spec.instanceId ?? "codex",
          providerInstanceId: spec.instanceId ?? "codex",
          runtimeMode: "full-access",
          activeTurnId: spec.turn?.state === "running" ? turnId : null,
          lastError: null,
          updatedAt,
        }
      : null,
    latestUserMessageAt: minutesAgo(spec.updatedMinutesAgo + 1),
    hasPendingApprovals: spec.hasPendingApprovals ?? false,
    hasPendingUserInput: spec.hasPendingUserInput ?? false,
    hasActionableProposedPlan: spec.hasActionableProposedPlan ?? false,
    ...(spec.settledMinutesAgo !== undefined
      ? { settledOverride: "settled", settledAt: minutesAgo(spec.settledMinutesAgo) }
      : {}),
    ...(spec.snoozedForever
      ? { snoozedUntil: SNOOZE_FOREVER, snoozedAt: minutesAgo(spec.updatedMinutesAgo) }
      : {}),
  };
}

function decodeShellSnapshot(input: {
  projects: ReadonlyArray<unknown>;
  threads: ReadonlyArray<unknown>;
}): OrchestrationShellSnapshot {
  return decodeShellSnapshotValue({
    snapshotSequence: 1,
    projects: input.projects,
    threads: input.threads,
    updatedAt: minutesAgo(0),
  });
}

function makeServerConfig(descriptor: ExecutionEnvironmentDescriptor, cwd: string): ServerConfig {
  const base = decodeServerConfigValue({
    environment: encodeEnvironmentDescriptorValue(descriptor),
    auth: {
      policy: "unsafe-no-auth",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "t3-demo-session",
    },
    cwd,
    keybindingsConfigPath: "~/.t3/keybindings.json",
    keybindings: [],
    issues: [],
    providers: demoProviders,
    availableEditors: [],
    observability: {
      logsDirectoryPath: "~/.t3/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
  });
  return { ...base, keybindings: DEFAULT_RESOLVED_KEYBINDINGS };
}

const demoCapabilities = {
  repositoryIdentity: false,
  threadSettlement: true,
  threadSnooze: true,
};

function makeDescriptor(input: {
  environmentId: string;
  label: string;
  os: ExecutionEnvironmentDescriptor["platform"]["os"];
  arch: ExecutionEnvironmentDescriptor["platform"]["arch"];
}): ExecutionEnvironmentDescriptor {
  return decodeEnvironmentDescriptorValue({
    environmentId: input.environmentId,
    label: input.label,
    platform: { os: input.os, arch: input.arch },
    serverVersion: demoServerVersion(import.meta.env.APP_VERSION || "0.0.0"),
    capabilities: demoCapabilities,
  });
}

// ---------------------------------------------------------------------------
// Environments: one local (primary) + two remote machines over T3 Connect
// ---------------------------------------------------------------------------

/**
 * Rebuilds the fixture's descriptor/config for the currently previewed demo
 * stage, so the mock server can report a live version change when the
 * marketing page switches channels without reloading the iframe.
 */
export function stagedDescriptor(fixture: DemoEnvironmentFixture): ExecutionEnvironmentDescriptor {
  return makeDescriptor({
    environmentId: fixture.environmentId,
    label: fixture.label,
    os: fixture.descriptor.platform.os,
    arch: fixture.descriptor.platform.arch,
  });
}

export function stagedServerConfig(fixture: DemoEnvironmentFixture): ServerConfig {
  return makeServerConfig(stagedDescriptor(fixture), fixture.serverConfig.cwd);
}

export interface DemoEnvironmentFixture {
  readonly environmentId: string;
  readonly label: string;
  /** Fake HTTPS origin the environment is served from; null = same-origin primary. */
  readonly origin: string | null;
  readonly bearerToken: string | null;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly serverConfig: ServerConfig;
  readonly shellSnapshot: OrchestrationShellSnapshot;
}

const primaryDescriptor = makeDescriptor({
  environmentId: DEMO_ENVIRONMENT_ID,
  label: DEMO_ENVIRONMENT_LABEL,
  os: "darwin",
  arch: "arm64",
});

const macStudioDescriptor = makeDescriptor({
  environmentId: "demo-mac-studio",
  label: "Mac Studio",
  os: "darwin",
  arch: "arm64",
});

const buildServerDescriptor = makeDescriptor({
  environmentId: "demo-build-server",
  label: "Build Server",
  os: "linux",
  arch: "x64",
});

const primaryShell = decodeShellSnapshot({
  projects: [
    {
      id: "project-marketing",
      title: "marketing-site",
      workspaceRoot: "~/code/marketing-site",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      scripts: [],
      createdAt: minutesAgo(60 * 24 * 12),
      updatedAt: minutesAgo(4),
    },
  ],
  threads: [
    demoThread({
      id: "thread-hero",
      projectId: "project-marketing",
      title: "Interactive hero demo",
      model: "claude-opus-5",
      instanceId: "claudeAgent",
      branch: "feat/hero-demo",
      createdMinutesAgo: 60 * 2,
      updatedMinutesAgo: 4,
      turn: { state: "running", startedMinutesAgo: 9 },
      sessionStatus: "running",
      hasPendingUserInput: true,
    }),
    demoThread({
      id: "thread-pricing",
      projectId: "project-marketing",
      title: "Pricing page copy refresh",
      model: "claude-sonnet-5",
      instanceId: "claudeAgent",
      branch: null,
      createdMinutesAgo: 60 * 26,
      updatedMinutesAgo: 60 * 5,
      turn: { state: "completed", startedMinutesAgo: 60 * 6, completedMinutesAgo: 60 * 5 },
      settledMinutesAgo: 60 * 4,
    }),
    demoThread({
      id: "thread-blog",
      projectId: "project-marketing",
      title: "Changelog RSS feed",
      model: "gpt-5.3-codex",
      branch: "feat/changelog-rss",
      createdMinutesAgo: 60 * 24 * 4,
      updatedMinutesAgo: 60 * 24 * 2,
      turn: {
        state: "completed",
        startedMinutesAgo: 60 * 24 * 2 + 20,
        completedMinutesAgo: 60 * 24 * 2,
      },
      snoozedForever: true,
    }),
  ],
});

const macStudioShell = decodeShellSnapshot({
  projects: [
    {
      id: "project-t3code",
      title: "t3code",
      workspaceRoot: "~/code/t3code",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      scripts: [],
      createdAt: minutesAgo(60 * 24 * 30),
      updatedAt: minutesAgo(1),
    },
  ],
  threads: [
    demoThread({
      id: "thread-composer",
      projectId: "project-t3code",
      title: "Composer attachments + drag-drop overlay",
      model: "gpt-5.3-codex",
      branch: "feat/composer-attachments",
      worktreePath: "~/code/t3code-worktrees/composer-attachments",
      createdMinutesAgo: 60 * 3,
      updatedMinutesAgo: 1,
      turn: { state: "running", startedMinutesAgo: 6 },
      sessionStatus: "running",
    }),
    demoThread({
      id: "thread-sidebar",
      projectId: "project-t3code",
      title: "Sidebar v2 polish — settled sort + jump hints",
      model: "grok-code-fast-2",
      instanceId: "grok",
      branch: "feat/sidebar-v2-polish",
      worktreePath: "~/code/t3code-worktrees/sidebar-v2-polish",
      createdMinutesAgo: 60 * 5,
      updatedMinutesAgo: 12,
      turn: { state: "running", startedMinutesAgo: 14 },
      sessionStatus: "running",
    }),
    demoThread({
      id: "thread-flaky",
      projectId: "project-t3code",
      title: "Fix flaky GitManager cross-repo test",
      model: "claude-opus-5",
      instanceId: "claudeAgent",
      branch: "fix/git-manager-test",
      worktreePath: "~/code/t3code-worktrees/git-manager-test",
      createdMinutesAgo: 60 * 8,
      updatedMinutesAgo: 35,
      turn: {
        id: "thread-flaky-turn-2",
        state: "completed",
        startedMinutesAgo: 48,
        completedMinutesAgo: 35,
      },
      sessionStatus: "ready",
    }),
    demoThread({
      id: "thread-relay",
      projectId: "project-t3code",
      title: "Relay reconnect backoff jitter",
      model: "claude-opus-5",
      instanceId: "claudeAgent",
      branch: "fix/relay-backoff",
      createdMinutesAgo: 60 * 30,
      updatedMinutesAgo: 60 * 9,
      turn: { state: "completed", startedMinutesAgo: 60 * 10, completedMinutesAgo: 60 * 9 },
      settledMinutesAgo: 60 * 8,
    }),
  ],
});

const buildServerShell = decodeShellSnapshot({
  projects: [
    {
      id: "project-mobile",
      title: "mobile-app",
      workspaceRoot: "~/code/mobile-app",
      defaultModelSelection: { instanceId: "grok", model: "grok-code-fast-2" },
      scripts: [],
      createdAt: minutesAgo(60 * 24 * 5),
      updatedAt: minutesAgo(8),
    },
  ],
  threads: [
    demoThread({
      id: "thread-metrics",
      projectId: "project-mobile",
      title: "Crash-free sessions dashboard",
      model: "claude-opus-5",
      instanceId: "claudeAgent",
      branch: "feat/crash-dashboard",
      worktreePath: DEMO_METRICS_WORKTREE_PATH,
      createdMinutesAgo: 60 * 6,
      updatedMinutesAgo: 8,
      turn: { id: "thread-metrics-turn-2", state: "running", startedMinutesAgo: 11 },
      sessionStatus: "running",
    }),
    demoThread({
      id: "thread-push",
      projectId: "project-mobile",
      title: "Push notifications deep links",
      model: "grok-code-fast-2",
      instanceId: "grok",
      branch: "feat/push-deeplinks",
      createdMinutesAgo: 60 * 30,
      updatedMinutesAgo: 60 * 20,
      turn: { state: "completed", startedMinutesAgo: 60 * 21, completedMinutesAgo: 60 * 20 },
    }),
    demoThread({
      id: "thread-ci",
      projectId: "project-mobile",
      title: "Nightly EAS build keeps timing out",
      model: "glm-5",
      instanceId: "opencode",
      branch: null,
      createdMinutesAgo: 60 * 24 * 6,
      updatedMinutesAgo: 60 * 24 * 3,
      turn: {
        state: "completed",
        startedMinutesAgo: 60 * 24 * 3 + 30,
        completedMinutesAgo: 60 * 24 * 3,
      },
      snoozedForever: true,
    }),
    demoThread({
      id: "thread-deploy",
      projectId: "project-mobile",
      title: "Blue/green deploy for the API",
      model: "gpt-5.3-codex",
      branch: "feat/blue-green",
      createdMinutesAgo: 60 * 24 * 8,
      updatedMinutesAgo: 60 * 24 * 1,
      turn: {
        state: "completed",
        startedMinutesAgo: 60 * 25,
        completedMinutesAgo: 60 * 24,
      },
      settledMinutesAgo: 60 * 22,
    }),
  ],
});

export const demoEnvironments: ReadonlyArray<DemoEnvironmentFixture> = [
  {
    environmentId: DEMO_ENVIRONMENT_ID,
    label: DEMO_ENVIRONMENT_LABEL,
    origin: null,
    bearerToken: null,
    descriptor: primaryDescriptor,
    serverConfig: makeServerConfig(primaryDescriptor, "~/code"),
    shellSnapshot: primaryShell,
  },
  {
    environmentId: "demo-mac-studio",
    label: "Mac Studio",
    origin: "https://mac-studio.t3connect.demo",
    bearerToken: "demo-mac-studio-token",
    descriptor: macStudioDescriptor,
    serverConfig: makeServerConfig(macStudioDescriptor, "~/code"),
    shellSnapshot: macStudioShell,
  },
  {
    environmentId: "demo-build-server",
    label: "Build Server",
    origin: "https://build-server.t3connect.demo",
    bearerToken: "demo-build-server-token",
    descriptor: buildServerDescriptor,
    serverConfig: makeServerConfig(buildServerDescriptor, "/home/deploy/code"),
    shellSnapshot: buildServerShell,
  },
];

/** Backwards-compatible aliases for the primary environment. */
export const demoDescriptor = primaryDescriptor;
export const demoServerConfig = demoEnvironments[0]!.serverConfig;
export const demoShellSnapshot = primaryShell;

/** Threads that open with the browser (right side panel) already visible. */
export const demoBrowserPanelThreadKeys: ReadonlyArray<string> = [
  "demo-mac-studio:thread-composer",
  "demo-build-server:thread-metrics",
];

export const demoDiffPanelSelectionByThreadKey = {
  "demo-mac-studio:thread-composer": "thread-composer-turn-0",
} as const;

// ---------------------------------------------------------------------------
// Git status per checkout, driving the real GitActionsControl in the header
// ---------------------------------------------------------------------------

const GITHUB_PROVIDER = {
  kind: "github",
  name: "GitHub",
  baseUrl: "https://github.com",
} as const;

export const demoVcsStatusByCwd: Record<string, VcsStatusStreamEvent> = {
  // Feature worktree with uncommitted changes: quick action is "Commit & push".
  "~/code/t3code-worktrees/composer-attachments": {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feat/composer-attachments",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: "apps/web/src/components/chat/ChatComposer.tsx", insertions: 187, deletions: 36 },
          { path: "apps/web/src/components/chat/DropOverlay.tsx", insertions: 11, deletions: 0 },
          {
            path: "apps/web/src/components/chat/ChatComposer.test.tsx",
            insertions: 74,
            deletions: 2,
          },
        ],
        insertions: 272,
        deletions: 38,
      },
    },
    remote: { hasUpstream: true, aheadCount: 2, behindCount: 0, aheadOfDefaultCount: 5, pr: null },
  },
  // Feature worktree with uncommitted changes and no PR yet.
  "~/code/t3code-worktrees/git-manager-test": {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "fix/git-manager-test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "apps/server/src/git/GitManager.test.ts", insertions: 21, deletions: 8 }],
        insertions: 21,
        deletions: 8,
      },
    },
    remote: { hasUpstream: true, aheadCount: 1, behindCount: 0, aheadOfDefaultCount: 2, pr: null },
  },
  // Clean feature worktree with an open PR.
  "~/code/t3code-worktrees/sidebar-v2-polish": {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feat/sidebar-v2-polish",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    },
    remote: {
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 3,
      pr: {
        number: 1287,
        title: "Sidebar v2 polish — settled sort + jump hints",
        url: "https://github.com/pingdotgg/t3code/pull/1287",
        baseRef: "main",
        headRef: "feat/sidebar-v2-polish",
        state: "open",
      },
    },
  },
  [DEMO_METRICS_WORKTREE_PATH]: {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feat/crash-dashboard",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: "src/pages/dashboard.tsx", insertions: 42, deletions: 6 },
          { path: "src/components/ReleasePicker.tsx", insertions: 86, deletions: 0 },
        ],
        insertions: 128,
        deletions: 6,
      },
    },
    remote: { hasUpstream: true, aheadCount: 1, behindCount: 0, aheadOfDefaultCount: 3, pr: null },
  },
  // Clean default checkouts.
  "~/code/t3code": {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: true,
      refName: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    },
    remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
  },
  "~/code/mobile-app": {
    _tag: "snapshot",
    local: {
      isRepo: true,
      sourceControlProvider: GITHUB_PROVIDER,
      hasPrimaryRemote: true,
      isDefaultRef: true,
      refName: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    },
    remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
  },
};

// The browser preview surface needs the Electron desktop bridge, so the web
// demo showcases the right panel with the diff surface instead.
const DEMO_COMPOSER_DIFF = `diff --git a/apps/web/src/components/chat/ChatComposer.tsx b/apps/web/src/components/chat/ChatComposer.tsx
index 3f1c2aa..9e84b71 100644
--- a/apps/web/src/components/chat/ChatComposer.tsx
+++ b/apps/web/src/components/chat/ChatComposer.tsx
@@ -41,6 +41,9 @@ export function ChatComposer(props: ChatComposerProps) {
   const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
+  const dragDepthRef = useRef(0);
+  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
+
   const textareaRef = useRef<HTMLTextAreaElement | null>(null);
${" "}
   const onSubmit = useCallback(() => {
@@ -108,7 +111,16 @@ export function ChatComposer(props: ChatComposerProps) {
-  return <form onSubmit={onSubmit}>{children}</form>;
+  return (
+    <form
+      onSubmit={onSubmit}
+      onDragEnter={onComposerDragEnter}
+      onDragLeave={onComposerDragLeave}
+      onDrop={onComposerDrop}
+    >
+      {isDragOverComposer ? <DropOverlay /> : null}
+      {children}
+    </form>
+  );
 }
diff --git a/apps/web/src/components/chat/DropOverlay.tsx b/apps/web/src/components/chat/DropOverlay.tsx
new file mode 100644
index 0000000..b2d61c4
--- /dev/null
+++ b/apps/web/src/components/chat/DropOverlay.tsx
@@ -0,0 +1,11 @@
+export function DropOverlay() {
+  return (
+    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/80 backdrop-blur-sm">
+      <p className="text-sm text-muted-foreground">Drop images to attach</p>
+    </div>
+  );
+}
`;

const decodeThreadTurnDiff = Schema.decodeUnknownSync(ThreadTurnDiff);
const decodeReviewDiffPreview = Schema.decodeUnknownSync(ReviewDiffPreviewResult);

const DEMO_SIDEBAR_REVIEW_DIFF = `diff --git a/apps/web/src/components/Sidebar.tsx b/apps/web/src/components/Sidebar.tsx
index 7f42311..b98170a 100644
--- a/apps/web/src/components/Sidebar.tsx
+++ b/apps/web/src/components/Sidebar.tsx
@@ -418,6 +418,7 @@ export function Sidebar() {
   const settledThreads = sortSettledThreads(threads);
+  const jumpHints = resolveActiveThreadJumpHints(threads, activeThreadId);
   return <SidebarList threads={settledThreads} />;
 }
`;

const demoReviewFixtureByCwd: Record<
  string,
  { readonly headRef: string; readonly threadId?: string; readonly diff?: string }
> = {
  "~/code/t3code-worktrees/composer-attachments": {
    headRef: "feat/composer-attachments",
    threadId: "thread-composer",
  },
  "~/code/t3code-worktrees/git-manager-test": {
    headRef: "fix/git-manager-test",
    threadId: "thread-flaky",
  },
  "~/code/t3code-worktrees/sidebar-v2-polish": {
    headRef: "feat/sidebar-v2-polish",
    diff: DEMO_SIDEBAR_REVIEW_DIFF,
  },
  [DEMO_METRICS_WORKTREE_PATH]: {
    headRef: "feat/crash-dashboard",
    threadId: "thread-metrics",
  },
};

export function demoReviewDiffPreview(cwd: string): ReviewDiffPreviewResult {
  const fixture = demoReviewFixtureByCwd[cwd];
  const diff =
    fixture?.diff ??
    (fixture?.threadId ? demoThreadDiff(fixture.threadId, 0, Number.MAX_SAFE_INTEGER).diff : "");
  return decodeReviewDiffPreview({
    cwd,
    generatedAt: DateTime.makeUnsafe(minutesAgo(2)),
    sources:
      fixture && diff
        ? [
            {
              id: "branch-range",
              kind: "branch-range",
              title: "Branch changes",
              baseRef: "main",
              headRef: fixture.headRef,
              diff,
              diffHash: `demo-diff-${fixture.threadId ?? fixture.headRef}`,
              truncated: false,
            },
          ]
        : [],
  });
}

function demoUnifiedDiffForFile(file: { readonly path: string; readonly kind: string }): string {
  if (file.kind === "added") {
    return `diff --git a/${file.path} b/${file.path}
new file mode 100644
index 0000000..9e84b71
--- /dev/null
+++ b/${file.path}
@@ -0,0 +1 @@
+// Added in this demo checkpoint.
`;
  }
  if (file.kind === "deleted") {
    return `diff --git a/${file.path} b/${file.path}
deleted file mode 100644
index 9e84b71..0000000
--- a/${file.path}
+++ /dev/null
@@ -1 +0,0 @@
-// Removed in this demo checkpoint.
`;
  }
  return `diff --git a/${file.path} b/${file.path}
index 3f1c2aa..9e84b71 100644
--- a/${file.path}
+++ b/${file.path}
@@ -1 +1 @@
-// Previous demo implementation.
+// Updated in this demo checkpoint.
`;
}

export function demoThreadDiff(
  threadId: string,
  fromTurnCount: number,
  toTurnCount: number,
): typeof ThreadTurnDiff.Type {
  const checkpoints =
    demoThreadDetails[threadId]?.checkpoints.filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.checkpointTurnCount > fromTurnCount &&
        checkpoint.checkpointTurnCount <= toTurnCount,
    ) ?? [];
  const filesByPath = new Map(
    checkpoints.flatMap((checkpoint) => checkpoint.files).map((file) => [file.path, file]),
  );
  const diff =
    threadId === "thread-composer" && fromTurnCount >= 1 && filesByPath.size > 0
      ? DEMO_COMPOSER_DIFF
      : [...filesByPath.values()].map(demoUnifiedDiffForFile).join("");
  return decodeThreadTurnDiff({ threadId, fromTurnCount, toTurnCount, diff });
}

// ---------------------------------------------------------------------------
// Thread histories (messages, activities, checkpoints)
// ---------------------------------------------------------------------------

const decodeMessages = Schema.decodeUnknownSync(Schema.Array(OrchestrationMessage));
const decodeActivities = Schema.decodeUnknownSync(Schema.Array(OrchestrationThreadActivity));
const decodeCheckpoints = Schema.decodeUnknownSync(Schema.Array(OrchestrationCheckpointSummary));

export interface DemoThreadDetail {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

function message(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId: string | null;
  minutesAgo: number;
  attachments?: ReadonlyArray<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    ...(input.attachments
      ? {
          attachments: input.attachments.map((attachment) => ({
            type: "image",
            ...attachment,
          })),
        }
      : {}),
    turnId: input.turnId,
    streaming: false,
    createdAt: minutesAgo(input.minutesAgo),
    updatedAt: minutesAgo(input.minutesAgo),
  };
}

export const demoThreadDetails: Record<string, DemoThreadDetail> = {
  "thread-composer": {
    messages: decodeMessages([
      message({
        id: "msg-composer-u0",
        role: "user",
        text: "Audit the composer for places where long pasted text breaks the layout.",
        turnId: "thread-composer-turn-a",
        minutesAgo: 60 * 3 - 5,
      }),
      message({
        id: "msg-composer-a0",
        role: "assistant",
        text: [
          "Found two overflow bugs:",
          "",
          "- `ChatComposer.tsx` let unbroken strings push the send button off-screen — fixed with `overflow-wrap: anywhere` on the editable area",
          "- The draft preview in the sidebar clipped multi-line drafts mid-glyph — now uses `line-clamp-2`",
          "",
          "Both have focused tests.",
        ].join("\n"),
        turnId: "thread-composer-turn-a",
        minutesAgo: 60 * 3 - 25,
      }),
      message({
        id: "msg-composer-u1",
        role: "user",
        text: "Add image attachments to the composer — drag & drop should show an overlay, and pasted screenshots should attach too. Here's the mock:",
        turnId: "thread-composer-turn-0",
        minutesAgo: 41,
        attachments: [
          {
            id: "att-drag-overlay",
            name: "drag-overlay-mock.png",
            mimeType: "image/png",
            sizeBytes: 48213,
          },
        ],
      }),
      message({
        id: "msg-composer-a1",
        role: "assistant",
        text: [
          "Done — the composer now accepts image attachments in three ways:",
          "",
          "1. **Drag & drop** anywhere over the composer (a dashed overlay appears while hovering)",
          "2. **Paste** a screenshot straight from the clipboard",
          "3. The **`+` attach button**, which opens the native file picker",
          "",
          "Key change in `ChatComposer.tsx`:",
          "",
          "```tsx",
          "const dragDepthRef = useRef(0);",
          "const onComposerDragEnter = (event: DragEvent) => {",
          "  if (!hasImageFiles(event)) return;",
          "  dragDepthRef.current += 1;",
          "  setIsDragOverComposer(true);",
          "};",
          "```",
          "",
          "Attachments over 10 MB are rejected with an inline error instead of a toast, and drafts persist attachments across reloads via `composerDraftStore`.",
        ].join("\n"),
        turnId: "thread-composer-turn-0",
        minutesAgo: 22,
      }),
      message({
        id: "msg-composer-u2",
        role: "user",
        text: "Nice. Now make the drop overlay match the new dark theme and add a subtle backdrop blur — I opened the preview in the side panel to check it live.",
        turnId: "thread-composer-turn-1",
        minutesAgo: 6,
      }),
    ]),
    activities: decodeActivities([
      {
        id: "act-composer-test",
        tone: "tool",
        kind: "tool.completed",
        summary: "vp test run apps/web/src/components/chat/ChatComposer.test.tsx",
        payload: {
          status: "completed",
          detail: "vp test run apps/web/src/components/chat/ChatComposer.test.tsx",
        },
        turnId: "thread-composer-turn-0",
        sequence: 1,
        createdAt: minutesAgo(24),
      },
    ]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-composer-turn-a",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-composer/1",
        status: "ready",
        files: [
          {
            path: "apps/web/src/components/chat/ChatComposer.tsx",
            kind: "modified",
            additions: 21,
            deletions: 8,
          },
        ],
        assistantMessageId: "msg-composer-a0",
        completedAt: minutesAgo(60 * 3 - 25),
      },
      {
        turnId: "thread-composer-turn-0",
        checkpointTurnCount: 2,
        checkpointRef: "refs/t3/checkpoints/thread-composer/2",
        status: "ready",
        files: [
          {
            path: "apps/web/src/components/chat/ChatComposer.tsx",
            kind: "modified",
            additions: 182,
            deletions: 24,
          },
          {
            path: "apps/web/src/components/ChatView.tsx",
            kind: "modified",
            additions: 36,
            deletions: 5,
          },
          {
            path: "apps/web/src/composerDraftStore.ts",
            kind: "modified",
            additions: 54,
            deletions: 9,
          },
        ],
        assistantMessageId: "msg-composer-a1",
        completedAt: minutesAgo(22),
      },
    ]),
  },
  "thread-hero": {
    messages: decodeMessages([
      message({
        id: "msg-hero-u0",
        role: "user",
        text: "What does the marketing hero currently render? Summarize before we change anything.",
        turnId: "thread-hero-turn-0",
        minutesAgo: 118,
      }),
      message({
        id: "msg-hero-a0",
        role: "assistant",
        text: [
          "The hero is a static `<img>` of an old screenshot:",
          "",
          "- `apps/marketing/src/pages/index.astro` renders `hero-screenshot.png` (1.4 MB, six months old)",
          "- No interactivity, and it drifts out of date every time the app UI changes",
        ].join("\n"),
        turnId: "thread-hero-turn-0",
        minutesAgo: 114,
      }),
      message({
        id: "msg-hero-u1",
        role: "user",
        text: "Replace the hero screenshot on the marketing site with a live demo of the actual app so visitors can click around.",
        turnId: "thread-hero-turn-1",
        minutesAgo: 110,
      }),
      message({
        id: "msg-hero-a1",
        role: "assistant",
        text: [
          "I can bundle the real app against fixture data — no duplicated markup, so the demo updates whenever the components do.",
          "",
          "### Plan",
          "- Build a standalone Vite entry that renders the real `AppRoot`",
          "- Mock only the transport boundary (WebSocket + `fetch`) with the production RPC contracts",
          "- Embed the generated bundle in the hero via an `iframe`",
          "",
          "One decision before I wire it up:",
        ].join("\n"),
        turnId: "thread-hero-turn-1",
        minutesAgo: 8,
      }),
    ]),
    activities: decodeActivities([
      {
        id: "act-hero-question",
        tone: "info",
        kind: "user-input.requested",
        summary: "Waiting for your answer",
        payload: {
          requestId: "req-hero-question",
          questions: [
            {
              id: "q-hero-layout",
              header: "Hero demo",
              question: "Which sidebar should the hero demo default to?",
              options: [
                {
                  label: "Sidebar v2 (flat list)",
                  description: "Showcase the new beta sidebar with rich active cards",
                },
                {
                  label: "Classic sidebar",
                  description: "Project-grouped v1 layout everyone already knows",
                },
              ],
              multiSelect: false,
            },
          ],
        },
        turnId: "thread-hero-turn-1",
        sequence: 2,
        createdAt: minutesAgo(4),
      },
    ]),
    checkpoints: decodeCheckpoints([]),
  },
  "thread-flaky": {
    messages: decodeMessages([
      message({
        id: "msg-flaky-u-pre-1",
        role: "user",
        text: "The cross-repo GitManager suite has become our slowest CI shard. Before changing anything, can you map where the time is going?",
        turnId: "thread-flaky-turn-pre-1",
        minutesAgo: 60 * 15,
      }),
      message({
        id: "msg-flaky-a-pre-1",
        role: "assistant",
        text: [
          "I profiled 40 runs on Linux and macOS. The test body is cheap; repository setup owns almost all of the variance:",
          "",
          "| Phase | median | p95 |",
          "| --- | ---: | ---: |",
          "| create temp repos | 180ms | 310ms |",
          "| seed remotes | 640ms | 4.8s |",
          "| fetch metadata | 220ms | 6.1s |",
          "| assertions | 14ms | 19ms |",
          "",
          "The long tail begins when the two fixture repositories are provisioned one after another.",
        ].join("\n"),
        turnId: "thread-flaky-turn-pre-1",
        minutesAgo: 60 * 14,
      }),
      message({
        id: "msg-flaky-u-pre-2",
        role: "user",
        text: "Could filesystem contention explain it? The failures seem more common on the shared Linux runners.",
        turnId: "thread-flaky-turn-pre-2",
        minutesAgo: 60 * 13,
      }),
      message({
        id: "msg-flaky-a-pre-2",
        role: "assistant",
        text: [
          "Partly, but it is exposing a test bug rather than a production bug.",
          "",
          "I forced I/O contention and reproduced the timeout locally. Both repository fixtures are independent, but the test awaits them serially and starts its 12-second deadline before the second fetch begins. A slow first remote leaves almost no budget for the second.",
          "",
          "I also checked the production path: it already resolves the remotes concurrently.",
        ].join("\n"),
        turnId: "thread-flaky-turn-pre-2",
        minutesAgo: 60 * 12,
      }),
      message({
        id: "msg-flaky-u-pre-3",
        role: "user",
        text: "Good. Please don't just raise the timeout. First isolate the race so we have a failing regression case.",
        turnId: "thread-flaky-turn-pre-3",
        minutesAgo: 60 * 11,
      }),
      message({
        id: "msg-flaky-a-pre-3",
        role: "assistant",
        text: [
          "I added a deterministic slow-remote fixture and ran only the affected test:",
          "",
          "```text",
          "GitManager cross-repository metadata",
          "  ✗ resolves fork metadata before deadline (12018ms)",
          "",
          "1 failed, 18 passed",
          "```",
          "",
          "The failure now reproduces every time without sleeping or polling. The assertion clock starts while `fork` is still provisioning.",
        ].join("\n"),
        turnId: "thread-flaky-turn-pre-3",
        minutesAgo: 60 * 10,
      }),
      message({
        id: "msg-flaky-u-pre-4",
        role: "user",
        text: "Does the same race affect pull request discovery, or only this test helper?",
        turnId: "thread-flaky-turn-pre-4",
        minutesAgo: 60 * 9,
      }),
      message({
        id: "msg-flaky-a-pre-4",
        role: "assistant",
        text: [
          "Only the test helper. I traced both call paths:",
          "",
          "- Production uses `Promise.all([origin, fork])` before metadata resolution",
          "- The test helper provisions `origin`, starts the deadline, then provisions `fork`",
          "- No runtime code shares the helper",
          "",
          "So this is safe to fix narrowly, and the regression test can mirror the production ordering.",
        ].join("\n"),
        turnId: "thread-flaky-turn-pre-4",
        minutesAgo: 60 * 8,
      }),
      message({
        id: "msg-flaky-u1",
        role: "user",
        text: "GitManager cross-repo PR metadata test is flaky in CI — times out at 12s roughly one run in five. Find it and fix it.",
        turnId: "thread-flaky-turn-1",
        minutesAgo: 60 * 7,
      }),
      message({
        id: "msg-flaky-a1",
        role: "assistant",
        text: [
          "Found it. The test raced the remote fetch against a fixed 12s timeout:",
          "",
          "- `GitManager.test.ts` spun up **two** temp repos but awaited their fixtures sequentially",
          "- The second `git fetch` occasionally started after the assertion deadline",
          "",
          "Fix: await both fixtures with `Promise.all` and assert on the settled result instead of polling.",
        ].join("\n"),
        turnId: "thread-flaky-turn-1",
        minutesAgo: 60 * 5,
      }),
      message({
        id: "msg-flaky-u2",
        role: "user",
        text: "Can you prove it's actually fixed and not just faster?",
        turnId: "thread-flaky-turn-2",
        minutesAgo: 60 * 2,
      }),
      message({
        id: "msg-flaky-a2",
        role: "assistant",
        text: [
          "Yes — three lines of evidence:",
          "",
          "1. **200 consecutive local runs** pass, worst case `1.62s` (old p95 was `11.4s`)",
          "2. The failure mode is structurally gone: both fixtures now resolve before the clock starts, so the deadline only covers the assertion itself",
          "3. I added a regression guard — the test now fails fast with a clear message if either fixture takes longer than `5s` to provision:",
          "",
          "```ts",
          "const [origin, fork] = await Promise.all([",
          '  provisionRepo("origin"),',
          '  provisionRepo("fork"),',
          ']).withTimeout("5 seconds");',
          "```",
        ].join("\n"),
        turnId: "thread-flaky-turn-2",
        minutesAgo: 35,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-flaky-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-flaky/1",
        status: "ready",
        files: [
          {
            path: "apps/server/src/git/GitManager.test.ts",
            kind: "modified",
            additions: 38,
            deletions: 21,
          },
        ],
        assistantMessageId: "msg-flaky-a1",
        completedAt: minutesAgo(60 * 5),
      },
      {
        turnId: "thread-flaky-turn-2",
        checkpointTurnCount: 2,
        checkpointRef: "refs/t3/checkpoints/thread-flaky/2",
        status: "ready",
        files: [
          {
            path: "apps/server/src/git/GitManager.test.ts",
            kind: "modified",
            additions: 14,
            deletions: 2,
          },
        ],
        assistantMessageId: "msg-flaky-a2",
        completedAt: minutesAgo(35),
      },
    ]),
  },
  "thread-sidebar": {
    messages: decodeMessages([
      message({
        id: "msg-sidebar-u1",
        role: "user",
        text: "Polish sidebar v2: settled threads should sort by settle time, and add the little jump hints when the active thread is scrolled out of view.",
        turnId: "thread-sidebar-turn-1",
        minutesAgo: 60 * 4,
      }),
      message({
        id: "msg-sidebar-a1",
        role: "assistant",
        text: [
          "Settled sort is in — settled rows now order by `settledAt` descending. Working on the jump hints next; I need to run the focused test suite to confirm the sort change:",
        ].join("\n"),
        turnId: "thread-sidebar-turn-1",
        minutesAgo: 16,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([]),
  },
  "thread-metrics": {
    messages: decodeMessages([
      message({
        id: "msg-metrics-u1",
        role: "user",
        text: "Build a crash-free sessions dashboard page — pull the numbers from the analytics API and chart the last 30 days.",
        turnId: "thread-metrics-turn-1",
        minutesAgo: 60 * 5,
      }),
      message({
        id: "msg-metrics-a1",
        role: "assistant",
        text: [
          "First cut is live on the dev server — I opened `localhost:3000/dashboard` in the browser panel so you can watch it update.",
          "",
          "- 30-day crash-free rate chart with a `99.5%` target line",
          "- Worst five crash groups with device/OS breakdown",
          "- Data refreshes every 60s via `useQuery` polling",
        ].join("\n"),
        turnId: "thread-metrics-turn-1",
        minutesAgo: 44,
      }),
      message({
        id: "msg-metrics-u2",
        role: "user",
        text: "Looks good. Add a release picker so we can compare crash rates across app versions.",
        turnId: "thread-metrics-turn-2",
        minutesAgo: 11,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-metrics-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-metrics/1",
        status: "ready",
        files: [
          {
            path: "src/pages/dashboard.tsx",
            kind: "added",
            additions: 214,
            deletions: 0,
          },
          {
            path: "src/api/analytics.ts",
            kind: "added",
            additions: 88,
            deletions: 0,
          },
        ],
        assistantMessageId: "msg-metrics-a1",
        completedAt: minutesAgo(44),
      },
    ]),
  },
  "thread-push": {
    messages: decodeMessages([
      message({
        id: "msg-push-u1",
        role: "user",
        text: "Tapping a push notification should deep-link into the exact chat thread, not just open the app.",
        turnId: "thread-push-turn-1",
        minutesAgo: 60 * 21,
      }),
      message({
        id: "msg-push-a1",
        role: "assistant",
        text: [
          "Deep links are wired up end-to-end:",
          "",
          "- Notification payloads now carry a `t3code://thread/:id` URL",
          "- Cold starts queue the link until the router is ready, warm starts navigate immediately",
          "- Android needed an extra `intent-filter`; iOS goes through `onNotificationOpenedApp`",
          "",
          "Tested on both platforms with the app killed, backgrounded, and foregrounded.",
        ].join("\n"),
        turnId: "thread-push-turn-1",
        minutesAgo: 60 * 20,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-push-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-push/1",
        status: "ready",
        files: [
          {
            path: "src/notifications/deepLinks.ts",
            kind: "added",
            additions: 96,
            deletions: 0,
          },
          {
            path: "app.config.ts",
            kind: "modified",
            additions: 12,
            deletions: 1,
          },
        ],
        assistantMessageId: "msg-push-a1",
        completedAt: minutesAgo(60 * 20),
      },
    ]),
  },
  "thread-pricing": {
    messages: decodeMessages([
      message({
        id: "msg-pricing-u1",
        role: "user",
        text: "Refresh the pricing page copy — clearer tier names and a proper FAQ.",
        turnId: "thread-pricing-turn-1",
        minutesAgo: 60 * 6,
      }),
      message({
        id: "msg-pricing-a1",
        role: "assistant",
        text: [
          "Shipped. Tiers are now **Solo / Team / Enterprise** with one-line value props, and the FAQ answers the six questions support sees most. Copy deck is in the PR description for review.",
        ].join("\n"),
        turnId: "thread-pricing-turn-1",
        minutesAgo: 60 * 5,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-pricing-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-pricing/1",
        status: "ready",
        files: [
          {
            path: "src/pages/pricing.astro",
            kind: "modified",
            additions: 68,
            deletions: 41,
          },
        ],
        assistantMessageId: "msg-pricing-a1",
        completedAt: minutesAgo(60 * 5),
      },
    ]),
  },
  "thread-relay": {
    messages: decodeMessages([
      message({
        id: "msg-relay-u1",
        role: "user",
        text: "Relay reconnects stampede after a network blip — add jitter to the backoff.",
        turnId: "thread-relay-turn-1",
        minutesAgo: 60 * 10,
      }),
      message({
        id: "msg-relay-a1",
        role: "assistant",
        text: [
          "Added full jitter to the reconnect schedule (`base * 2^attempt * random(0.5, 1)` capped at 30s). A simulated 500-client blip now spreads reconnects across 14 seconds instead of all landing in the same 200ms window.",
        ].join("\n"),
        turnId: "thread-relay-turn-1",
        minutesAgo: 60 * 9,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-relay-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-relay/1",
        status: "ready",
        files: [
          {
            path: "packages/relay/src/reconnect.ts",
            kind: "modified",
            additions: 27,
            deletions: 9,
          },
        ],
        assistantMessageId: "msg-relay-a1",
        completedAt: minutesAgo(60 * 9),
      },
    ]),
  },
  "thread-ci": {
    messages: decodeMessages([
      message({
        id: "msg-ci-u1",
        role: "user",
        text: "The nightly EAS build keeps timing out. Investigate, but this is not urgent — snoozing it.",
        turnId: "thread-ci-turn-1",
        minutesAgo: 60 * 24 * 3 + 40,
      }),
      message({
        id: "msg-ci-a1",
        role: "assistant",
        text: [
          "Initial findings: the timeout is in the native dependency compile step, which doubled after the RN 0.85 upgrade. Caching the NDK artifacts should cut it below the limit — parked until you unsnooze.",
        ].join("\n"),
        turnId: "thread-ci-turn-1",
        minutesAgo: 60 * 24 * 3,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([]),
  },
  "thread-blog": {
    messages: decodeMessages([
      message({
        id: "msg-blog-u1",
        role: "user",
        text: "Add an RSS feed for the changelog. Low priority — park it after the first pass.",
        turnId: "thread-blog-turn-1",
        minutesAgo: 60 * 24 * 2 + 30,
      }),
      message({
        id: "msg-blog-a1",
        role: "assistant",
        text: [
          'First pass done: `/changelog/rss.xml` renders the ten latest entries with correct `pubDate`s. Still todo when you pick this back up: full-content encoding and a `<link rel="alternate">` tag on the changelog page.',
        ].join("\n"),
        turnId: "thread-blog-turn-1",
        minutesAgo: 60 * 24 * 2,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-blog-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-blog/1",
        status: "ready",
        files: [
          {
            path: "src/pages/changelog/rss.xml.ts",
            kind: "added",
            additions: 52,
            deletions: 0,
          },
        ],
        assistantMessageId: "msg-blog-a1",
        completedAt: minutesAgo(60 * 24 * 2),
      },
    ]),
  },
  "thread-deploy": {
    messages: decodeMessages([
      message({
        id: "msg-deploy-u1",
        role: "user",
        text: "Set up blue/green deploys for the API so releases stop dropping requests.",
        turnId: "thread-deploy-turn-1",
        minutesAgo: 60 * 26,
      }),
      message({
        id: "msg-deploy-a1",
        role: "assistant",
        text: [
          "Blue/green is live:",
          "",
          "1. Deploys provision the idle color, run smoke tests, then swap the load balancer target group",
          "2. Rollback is a single swap back — no rebuild",
          "3. Yesterday's release shipped with **zero** dropped requests (previous deploys dropped ~120)",
        ].join("\n"),
        turnId: "thread-deploy-turn-1",
        minutesAgo: 60 * 24,
      }),
    ]),
    activities: decodeActivities([]),
    checkpoints: decodeCheckpoints([
      {
        turnId: "thread-deploy-turn-1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread-deploy/1",
        status: "ready",
        files: [
          {
            path: "infra/deploy/blue-green.ts",
            kind: "added",
            additions: 143,
            deletions: 0,
          },
          {
            path: ".github/workflows/deploy.yml",
            kind: "modified",
            additions: 31,
            deletions: 18,
          },
        ],
        assistantMessageId: "msg-deploy-a1",
        completedAt: minutesAgo(60 * 24),
      },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Asset fixtures (project favicons + message attachments)
// ---------------------------------------------------------------------------

function demoSiteAssetUrl(pathname: string): string {
  if (typeof window === "undefined") return pathname;
  return new URL(pathname, window.location.origin).toString();
}

export const demoProjectFaviconUrlByCwd: Record<string, string> = {
  "~/code/t3code": demoSiteAssetUrl("/favicon-32x32.png"),
  "~/code/marketing-site": "https://www.google.com/s2/favicons?domain=astro.build&sz=64",
  "~/code/mobile-app": "https://www.google.com/s2/favicons?domain=expo.dev&sz=64",
  [DEMO_METRICS_WORKTREE_PATH]: "https://www.google.com/s2/favicons?domain=expo.dev&sz=64",
};

const dragOverlayMockSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">',
  '<rect width="640" height="400" fill="#101012"/>',
  '<rect x="24" y="24" width="180" height="352" rx="12" fill="#18181b"/>',
  '<rect x="228" y="24" width="388" height="352" rx="12" fill="#141417" stroke="#2e2e33" stroke-width="2" stroke-dasharray="8 6"/>',
  '<text x="422" y="196" fill="#9b9ba4" font-family="system-ui, sans-serif" font-size="17" text-anchor="middle">Drop images to attach</text>',
  '<text x="422" y="222" fill="#5c5c66" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">PNG, JPEG or WebP — up to 10 MB</text>',
  "</svg>",
].join("");

export const demoAttachmentUrlById: Record<string, string> = {
  "att-drag-overlay": `data:image/svg+xml,${encodeURIComponent(dragOverlayMockSvg)}`,
};
