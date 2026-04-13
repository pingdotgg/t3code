// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  type TurnId,
  WS_METHODS,
  OrchestrationSessionStatus,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig } from "../rpc/serverState";
import { getRouter } from "../router";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const THREAD_ID = "thread-browser-test" as ThreadId;
const ARCHIVED_SECONDARY_THREAD_ID = "thread-secondary-project-archived" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const SECOND_PROJECT_ID = "project-2" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
const THREAD_KEY = scopedThreadKey(THREAD_REF);
const UUID_ROUTE_RE = /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_DRAFT_KEY = `${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`;
const PROJECT_KEY = scopedProjectKey(scopeProjectRef(LOCAL_ENVIRONMENT_ID, PROJECT_ID));
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();
const wsRequests = rpcHarness.requests;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const WIDE_FOOTER_VIEWPORT: ViewportSpec = {
  name: "wide-footer",
  width: 1_400,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const COMPACT_FOOTER_VIEWPORT: ViewportSpec = {
  name: "compact-footer",
  width: 430,
  height: 932,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  setContainerSize: (viewport: Pick<ViewportSpec, "width" | "height">) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl: `/attachments/attachment-${attachmentIndex + 1}`,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Browser test thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Local environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function toShellThread(thread: OrchestrationReadModel["threads"][number]) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    session: thread.session,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function toShellSnapshot(snapshot: OrchestrationReadModel) {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: snapshot.threads.map(toShellThread),
    updatedAt: snapshot.updatedAt,
  };
}

function updateThreadSessionInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  session: OrchestrationReadModel["threads"][number]["session"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            session,
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

function sendShellThreadUpsert(
  threadId: ThreadId,
  options?: {
    readonly session?: OrchestrationReadModel["threads"][number]["session"];
  },
): void {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Expected thread ${threadId} in snapshot.`);
  }

  const shellThread =
    options?.session !== undefined
      ? toShellThread({ ...thread, session: options.session })
      : toShellThread(thread);
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "thread-upserted",
    sequence: fixture.snapshot.snapshotSequence,
    thread: shellThread,
  });
}

async function waitForWsClient(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell),
      ).toBe(true);
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

function threadRefFor(threadId: ThreadId) {
  return scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
}

function threadKeyFor(threadId: ThreadId): string {
  return scopedThreadKey(threadRefFor(threadId));
}

function composerDraftFor(target: string) {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  return draftsByThreadKey[target] ?? draftsByThreadKey[threadKeyFor(target as ThreadId)];
}

function draftIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  const draftId = segments[segments.length - 1];
  if (!draftId) {
    throw new Error(`Expected thread path, received "${pathname}".`);
  }
  return DraftId.make(draftId);
}

function draftThreadIdFor(draftId: ReturnType<typeof draftIdFromPath>): ThreadId {
  const draftSession = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!draftSession) {
    throw new Error(`Expected draft session for "${draftId}".`);
  }
  return draftSession.threadId;
}

function serverThreadPath(threadId: ThreadId): string {
  return `/${LOCAL_ENVIRONMENT_ID}/${threadId}`;
}

async function waitForAppBootstrap(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
      expect(selectBootstrapCompleteForActiveEnvironment(useStore.getState())).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function materializePromotedDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await waitForWsClient();
  fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, null);
  sendShellThreadUpsert(threadId, { session: null });
}

async function startPromotedServerThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: `turn-${threadId}` as TurnId,
    lastError: null,
    updatedAt: NOW_ISO,
  });
  sendShellThreadUpsert(threadId);
}

async function promoteDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await materializePromotedDraftThreadViaDomainEvent(threadId);
  await startPromotedServerThreadViaDomainEvent(threadId);
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[threadKeyFor(threadId)]).toBe(
        undefined,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function createProjectlessSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-projectless-target" as MessageId,
    targetText: "projectless",
  });
  return {
    ...snapshot,
    projects: [],
    threads: [],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [THREAD_KEY]: {
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {
      [PROJECT_DRAFT_KEY]: THREAD_KEY,
    },
  });
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithSecondaryProject(options?: {
  includeSecondaryThread?: boolean;
  includeArchivedSecondaryThread?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-secondary-project-target" as MessageId,
    targetText: "secondary project",
  });
  const includeSecondaryThread = options?.includeSecondaryThread ?? true;
  const includeArchivedSecondaryThread = options?.includeArchivedSecondaryThread ?? true;
  const secondaryThreads: OrchestrationReadModel["threads"] = includeSecondaryThread
    ? [
        {
          id: "thread-secondary-project" as ThreadId,
          projectId: SECOND_PROJECT_ID,
          title: "Release checklist",
          modelSelection: { provider: "codex", model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-portal",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(30),
          updatedAt: isoAt(31),
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: "thread-secondary-project" as ThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(31),
          },
          archivedAt: null,
        },
      ]
    : [];
  const archivedSecondaryThreads: OrchestrationReadModel["threads"] = includeArchivedSecondaryThread
    ? [
        {
          id: ARCHIVED_SECONDARY_THREAD_ID,
          projectId: SECOND_PROJECT_ID,
          title: "Archived Docs Notes",
          modelSelection: { provider: "codex", model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-archive",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(24),
          updatedAt: isoAt(25),
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: ARCHIVED_SECONDARY_THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(25),
          },
          archivedAt: isoAt(26),
        },
      ]
    : [];

  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: SECOND_PROJECT_ID,
        title: "Docs Portal",
        workspaceRoot: "/repo/clients/docs-portal",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
  };
}

function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: "question thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            activities: [
              {
                id: EventId.make("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "What should this change cover?",
                      options: [
                        {
                          label: "Tight",
                          description: "Touch only the footer layout logic.",
                        },
                        {
                          label: "Broad",
                          description: "Also adjust the related composer controls.",
                        },
                      ],
                    },
                    {
                      id: "risk",
                      header: "Risk",
                      question: "How aggressive should the imaginary plan be?",
                      options: [
                        {
                          label: "Conservative",
                          description: "Favor reliability and low-risk changes.",
                        },
                        {
                          label: "Balanced",
                          description: "Mix quick wins with one structural improvement.",
                        },
                      ],
                    },
                  ],
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

function createSnapshotWithPlanFollowUpPrompt(options?: {
  modelSelection?: { provider: "codex"; model: string };
  planMarkdown?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });
  const modelSelection = options?.modelSelection ?? {
    provider: "codex" as const,
    model: "gpt-5",
  };
  const planMarkdown =
    options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
    ),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_002),
                updatedAt: isoAt(1_003),
              },
            ],
            session: {
              ...thread.session,
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      nextCursor: null,
      totalCount: 1,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor) {
    return null;
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      worktreePath:
        typeof body.worktreePath === "string"
          ? body.worktreePath
          : body.worktreePath === null
            ? null
            : null,
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      void rpcHarness.onMessage(rawData);
    });
  }),
  ...createAuthenticatedSessionHandlers(() => fixture.serverConfig.auth),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function pressComposerKey(key: string): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const keydownEvent = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(keydownEvent);
  if (keydownEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  const beforeInputEvent = new InputEvent("beforeinput", {
    data: key,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(beforeInputEvent);
  if (beforeInputEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  if (
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, key)
  ) {
    await waitForLayout();
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Unable to resolve composer selection for text input.");
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(key);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  composerEditor.dispatchEvent(
    new InputEvent("input", {
      data: key,
      inputType: "insertText",
      bubbles: true,
    }),
  );
  await waitForLayout();
}

async function pressComposerUndo(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  const useMetaForMod = isMacPlatform(navigator.platform);
  composerEditor.focus();
  composerEditor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

async function waitForComposerText(expectedText: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        expectedText,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function setComposerSelectionByTextOffsets(options: {
  start: number;
  end: number;
  direction?: "forward" | "backward";
}): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const resolvePoint = (targetOffset: number) => {
    const traversedRef = { value: 0 };

    const visitNode = (node: Node): { node: Node; offset: number } | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (targetOffset <= traversedRef.value + textLength) {
          return {
            node,
            offset: Math.max(0, Math.min(targetOffset - traversedRef.value, textLength)),
          };
        }
        traversedRef.value += textLength;
        return null;
      }

      if (node instanceof HTMLBRElement) {
        const parent = node.parentNode;
        if (!parent) {
          return null;
        }
        const siblingIndex = Array.prototype.indexOf.call(parent.childNodes, node);
        if (targetOffset <= traversedRef.value) {
          return { node: parent, offset: siblingIndex };
        }
        if (targetOffset <= traversedRef.value + 1) {
          return { node: parent, offset: siblingIndex + 1 };
        }
        traversedRef.value += 1;
        return null;
      }

      if (node instanceof Element || node instanceof DocumentFragment) {
        for (const child of node.childNodes) {
          const point = visitNode(child);
          if (point) {
            return point;
          }
        }
      }

      return null;
    };

    return (
      visitNode(composerEditor) ?? {
        node: composerEditor,
        offset: composerEditor.childNodes.length,
      }
    );
  };

  const startPoint = resolvePoint(options.start);
  const endPoint = resolvePoint(options.end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();

  if (options.direction === "backward" && "setBaseAndExtent" in selection) {
    selection.setBaseAndExtent(endPoint.node, endPoint.offset, startPoint.node, startPoint.offset);
    await waitForLayout();
    return;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.addRange(range);
  await waitForLayout();
}

async function selectAllComposerContent(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(composerEditor);
  selection.addRange(range);
  await waitForLayout();
}

async function waitForComposerMenuItem(itemId: string): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-composer-item-id="${itemId}"]`),
    `Unable to find composer menu item "${itemId}".`,
  );
}
async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function findComposerProviderModelPicker(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]');
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(() => findButtonByText(text), `Unable to find "${text}" button.`);
}

function findButtonContainingText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => findButtonContainingText(text),
    `Unable to find button containing "${text}".`,
  );
}

async function waitForSelectItemContainingText(text: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find((item) =>
        item.textContent?.includes(text),
      ) ?? null,
    `Unable to find select item containing "${text}".`,
  );
}

async function expectComposerActionsContained(): Promise<void> {
  const footer = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
    "Unable to find composer footer.",
  );
  const actions = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
    "Unable to find composer actions container.",
  );

  await vi.waitFor(
    () => {
      const footerRect = footer.getBoundingClientRect();
      const actionButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(footerRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(1.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Build" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchChatNewShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "o",
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchChatNewShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function openCommandPaletteFromTrigger(): Promise<void> {
  const trigger = page.getByTestId("command-palette-trigger");
  await expect.element(trigger).toBeInTheDocument();
  await trigger.click();
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette"]'),
    "Command palette should have opened from the sidebar trigger.",
  );
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await newThreadButton.hover();
  const shortcutLabel = isMacPlatform(navigator.platform)
    ? "New thread (⇧⌘O)"
    : "New thread (Ctrl+Shift+O)";
  await expect.element(page.getByText(shortcutLabel)).toBeInTheDocument();
}

async function waitForCommandPaletteShortcutLabel(): Promise<void> {
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette-trigger"] kbd'),
    "Command palette shortcut label did not render.",
  );
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  initialPath?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  customWsRpcResolver = options.resolveRpc ?? null;
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [options.initialPath ?? `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`],
    }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    {
      container: host,
    },
  );

  await waitForWsClient();
  await waitForAppBootstrap();
  await waitForLayout();

  const cleanup = async () => {
    customWsRpcResolver = null;
    await screen.unmount();
    host.remove();
    await waitForLayout();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    setContainerSize: async (viewport) => {
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
    },
    router,
  };
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: fixture.serverConfig,
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeShell) {
          return [
            {
              kind: "snapshot",
              snapshot: toShellSnapshot(fixture.snapshot),
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
          const thread = fixture.snapshot.threads.find((entry) => entry.id === request.threadId);
          return thread
            ? [
                {
                  kind: "snapshot",
                  snapshot: {
                    snapshotSequence: fixture.snapshot.snapshotSequence,
                    thread,
                  },
                },
              ]
            : [];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    customWsRpcResolver = null;
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useCommandPaletteStore.setState({
      open: false,
    });
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    useUiStateStore.setState({
      projectExpandedById: {},
      projectOrder: [],
      threadLastVisitedAtById: {},
    });
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
  });
  it("re-expands the bootstrap project using its scoped key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_KEY]: false,
      },
      projectOrder: [PROJECT_KEY],
      threadLastVisitedAtById: {},
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
        targetText: "bootstrap project expand",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an explicit empty state for projects without threads in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("No threads yet")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not leak a server worktree path into drawer runtime env when launch context clears it", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-launch-context-target" as MessageId,
      targetText: "launch context worktree override",
    });
    const targetThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (targetThread) {
      Object.assign(targetThread, {
        branch: "feature/branch",
        worktreePath: "/repo/worktrees/feature-branch",
      });
    }

    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [THREAD_KEY]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
      terminalLaunchContextByThreadKey: {
        [THREAD_KEY]: {
          cwd: "/repo/project",
          worktreePath: null,
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          ) as
            | {
                _tag: string;
                cwd?: string;
                worktreePath?: string | null;
                env?: Record<string, string>;
              }
            | undefined;
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            cwd: "/repo/project",
            worktreePath: null,
            env: {
              T3CODE_PROJECT_ROOT: "/repo/project",
            },
          });
          expect(openRequest?.env?.T3CODE_WORKTREE_PATH).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with Trae when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["trae"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "trae",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) ?? null,
        "Unable to find VSCodium menu item.",
      );
      (vscodiumItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("t3code:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              T3CODE_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              T3CODE_PROJECT_ROOT: "/repo/project",
              T3CODE_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/pingdotgg/t3code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/pingdotgg/t3code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      branchButton.click();

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to find branch search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search branches...").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout Pull Request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      worktreeButton.click();

      await vi.waitFor(
        () => {
          const prepareRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
          );
          expect(prepareRequest).toMatchObject({
            _tag: WS_METHODS.gitPreparePullRequestThread,
            cwd: "/repo/project",
            reference: "1359",
            mode: "worktree",
            threadId: THREAD_ID,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;
          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite &&
            request.threadId === THREAD_ID &&
            request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps new-worktree mode on empty server threads and bootstraps the first send", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitListBranches) {
          return {
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: 1,
            branches: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("New worktree")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;

          expect(turnStartRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
          expect(turnStartRequest?.bootstrap?.createThread).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates the selected worktree base branch on empty server threads", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitListBranches) {
          return {
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: 2,
            branches: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();
      await page.getByText("From main", { exact: true }).click();
      await page.getByText("release/next", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("From release/next")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  prepareWorktree?: { baseBranch?: string };
                };
              }
            | undefined;

          expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears pending worktree overrides when switching empty server threads", async () => {
    const secondThreadId = "thread-browser-test-second" as ThreadId;
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const snapshotWithSecondThread = addThreadToSnapshot(snapshot, secondThreadId);
    const snapshotWithTwoThreads = {
      ...snapshotWithSecondThread,
      threads: snapshotWithSecondThread.threads.map((thread) => {
        if (thread.id === THREAD_ID) {
          return Object.assign({}, thread, { session: null, title: "Thread alpha" });
        }
        if (thread.id === secondThreadId) {
          return Object.assign({}, thread, { session: null, title: "Thread beta" });
        }
        return thread;
      }),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithTwoThreads,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitListBranches) {
          return {
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: 2,
            branches: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();
      await page.getByText("From main", { exact: true }).click();
      await page.getByText("release/next", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("From release/next")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: secondThreadId,
        },
      });

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(secondThreadId),
        "Route should switch to the second empty server thread.",
      );

      await vi.waitFor(
        () => {
          expect(findButtonByText("Current checkout")).toBeTruthy();
          expect(findButtonByText("From release/next")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      (await waitForButtonByText("Current checkout")).click();
      await page.getByText("New worktree", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(findButtonByText("From main")).toBeTruthy();
          expect(findButtonByText("From release/next")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the send state once bootstrap dispatch is in flight", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Build");
      expect(initialModeButton.title).toContain("enter plan mode");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Build")).title).toContain("enter plan mode");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "return to normal build mode",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Build")).title).toContain("enter plan mode");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active draft route session when changing the base branch", async () => {
    const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
    const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
        [activeDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
        [PROJECT_DRAFT_KEY]: activeDraftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${activeDraftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitListBranches) {
          return {
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: 2,
            branches: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From main",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From main".',
      );
      branchButton.click();

      const branchOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "release/next",
          ) as HTMLSpanElement | null,
        'Unable to find the "release/next" branch option.',
      );
      branchOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "release/next",
          );
          expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
            "main",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const updatedButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.trim().includes("From release/next"),
          );
          expect(updatedButton).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
    const draftId = DraftId.make("draft-branch-picker-scroll-regression");
    const branches = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        name: `feature/${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
      {
        name: "feature/selected",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/selected",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitListBranches) {
          return {
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            branches,
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From feature/selected",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From feature/selected".',
      );
      branchButton.click();

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to find branch search input.",
      );

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the branch picker popup.",
      );

      await vi.waitFor(
        () => {
          const popupSpans = Array.from(popup.querySelectorAll("span"));
          expect(
            popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
          ).toBe(true);
          expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-basic" as MessageId,
        targetText: "surround basic",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({ start: 0, end: "selected".length });
      await pressComposerKey("(");
      await waitForComposerText("(selected)");

      await pressComposerKey("[");
      await waitForComposerText("([selected])");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-collapsed" as MessageId,
        targetText: "surround collapsed",
      }),
    });

    try {
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: "selected".length,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("selected(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports symmetric and backward-selection surrounds", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-backward" as MessageId,
        targetText: "surround backward",
      }),
    });

    try {
      await waitForComposerText("backward");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "backward".length,
        direction: "backward",
      });
      await pressComposerKey("*");
      await waitForComposerText("*backward*");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports option-produced surround symbols like guillemets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-guillemet" as MessageId,
        targetText: "surround guillemet",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      await pressComposerKey("«");
      await waitForComposerText("«quoted»");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-dead-quote" as MessageId,
        targetText: "surround dead quote",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertCompositionText",
          bubbles: true,
          cancelable: true,
        }),
      );
      const resolvedInputEvent = new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(resolvedInputEvent);
      expect(resolvedInputEvent.defaultPrevented).toBe(true);
      await waitForComposerText("'quoted'");
      await pressComposerUndo();
      await waitForComposerText("quoted");
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds text after a mention using the correct expanded offsets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-after-mention" as MessageId,
        targetText: "surround after mention",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForComposerText("hi @package.json there");
      await setComposerSelectionByTextOffsets({
        start: "hi package.json ".length,
        end: "hi package.json there".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("hi @package.json (there)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to normal replacement when the selection includes a mention token", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-token" as MessageId,
        targetText: "surround token",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await selectAllComposerContent();
      await pressComposerKey("(");
      await waitForComposerText("(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows runtime mode descriptions in the desktop composer access select", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const runtimeModeSelect = await waitForButtonByText("Full access");
      runtimeModeSelect.click();

      expect((await waitForSelectItemContainingText("Supervised")).textContent).toContain(
        "Ask before commands and file changes",
      );

      const autoAcceptItem = await waitForSelectItemContainingText("Auto-accept edits");
      expect(autoAcceptItem.textContent).toContain("Auto-approve edits");
      expect((await waitForSelectItemContainingText("Full access")).textContent).toContain(
        "Allow commands and edits without prompts",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadKey[THREAD_KEY]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_REF, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_REF, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_REF,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_REF, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the archive action when the pointer leaves a thread row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-hover-test" as MessageId,
        targetText: "archive hover target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

      await expect.element(threadRow).toBeInTheDocument();
      const archiveButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(`[data-testid="thread-archive-${THREAD_ID}"]`),
        "Unable to find archive button.",
      );
      const archiveAction = archiveButton.parentElement;
      expect(
        archiveAction,
        "Archive button should render inside a visibility wrapper.",
      ).not.toBeNull();
      expect(getComputedStyle(archiveAction!).opacity).toBe("0");

      await threadRow.hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("1");
        },
        { timeout: 4_000, interval: 16 },
      );

      await page.getByTestId("composer-editor").hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("0");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the confirm archive action after clicking the archive button", async () => {
    localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        confirmThreadArchive: true,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as MessageId,
        targetText: "archive confirm target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

      await expect.element(threadRow).toBeInTheDocument();
      await threadRow.hover();

      const archiveButton = page.getByTestId(`thread-archive-${THREAD_ID}`);
      await expect.element(archiveButton).toBeInTheDocument();
      await archiveButton.click();

      const confirmButton = page.getByTestId(`thread-archive-confirm-${THREAD_ID}`);
      await expect.element(confirmButton).toBeInTheDocument();
      await expect.element(confirmButton).toBeVisible();
    } finally {
      localStorage.removeItem("t3code:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("canonicalizes promoted draft threads to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // `thread.created` should only mark the draft as promoting; it should
      // not navigate away until the server thread has actual runtime state.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Once the server thread starts, the route should canonicalize.
      await startPromotedServerThreadViaDomainEvent(newThreadId);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftThreadsByThreadKey[newDraftId]).toBe(
            undefined,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // The route should switch to the canonical server thread path.
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );

      // The composer should remain usable after canonicalization, regardless of
      // whether the promoted thread is still visibly empty or has already
      // entered the running state.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes stale promoted draft routes to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
        targetText: "draft hydration race test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      await promoteDraftThreadViaDomainEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Stale promoted draft routes should canonicalize to the server thread path.",
      );

      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toBe(undefined);
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const draftId = draftIdFromPath(threadPath);

      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(draftId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });

      await newThreadButton.click();

      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.4",
            options: {
              reasoningEffort: "low",
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not consume chat.new when there is no project context", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
        targetText: "command palette shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("New thread in Project", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the command palette.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters command palette results as the user types", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-search-test" as MessageId,
        targetText: "command palette search test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps project-context thread matches available when searching by project name", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Release checklist", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches projects by path and opens the latest thread for that project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the latest thread for the selected project.",
      );
      expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
      expect(
        useComposerDraftStore
          .getState()
          .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from project search when no active project thread exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({ includeSecondaryThread: false }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project search result.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
      expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
      expect(draftThread?.envMode).toBe("worktree");
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters archived threads out of command palette search results", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs-archive");
      await expect
        .element(palette.getByText("Archived Docs Notes", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedDraftId = draftIdFromPath(promotedThreadPath);
      const promotedThreadId = draftThreadIdFor(promotedDraftId);

      await promoteDraftThreadViaDomainEvent(promotedThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(promotedThreadId),
        "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
      );
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
    const snapshot = createSnapshotWithLongProposedPlan();
    const threads = snapshot.threads.slice();
    const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
    const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
    if (targetThread) {
      threads[targetThreadIndex] = {
        ...targetThread,
        worktreePath: "/repo/worktrees/plan-thread",
      };
    }

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads,
      },
    });

    try {
      const planActionsButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find proposed plan actions button.",
      );
      planActionsButton.click();

      const saveToWorkspaceItem = await waitForElement(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null) as HTMLElement | null,
        'Unable to find "Save to workspace" menu item.',
      );
      saveToWorkspaceItem.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Enter a path relative to /repo/worktrees/plan-thread.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");

      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits pending user input after the final option selection resolves the draft answers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      const finalOption = await waitForButtonContainingText("Conservative");
      finalOption.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ) as
            | {
                _tag: string;
                type?: string;
                requestId?: string;
                answers?: Record<string, unknown>;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.user-input.respond",
            requestId: "req-browser-user-input",
            answers: {
              scope: "Tight",
              risk: "Conservative",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      const initialImplementButton = await waitForButtonByText("Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setContainerSize({
        width: 440,
        height: WIDE_FOOTER_VIEWPORT.height,
      });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: { provider: "codex", model: "gpt-5.3-codex-spark" },
        planMarkdown:
          "# Imaginary Long-Range Plan: T3 Code Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: { provider: "codex", model: "gpt-5.3-codex-spark" },
        planMarkdown:
          "# Imaginary Long-Range Plan: T3 Code Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a tooltip with the skill description when hovering a skill pill", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
        targetText: "skill tooltip thread",
      }),
      configureFixture: (nextFixture) => {
        const provider = nextFixture.serverConfig.providers[0];
        if (!provider) {
          throw new Error("Expected default provider in test fixture.");
        }
        (
          provider as {
            skills: ServerConfig["providers"][number]["skills"];
          }
        ).skills = [
          {
            name: "agent-browser",
            displayName: "Agent Browser",
            description: "Open pages, click around, and inspect web apps.",
            path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
            enabled: true,
          },
        ];
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "use the $agent-browser ");
      await waitForComposerText("use the $agent-browser ");

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
        "Unable to find rendered composer skill chip.",
      );
      await page.getByText("Agent Browser").hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain("Open pages, click around, and inspect web apps.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
