// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  CommandId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type EnvironmentApi,
  type OrchestrationEvent,
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
  type DesktopBridge,
  CheckpointRef,
} from "@forma/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import { createModelCapabilities, createModelSelection } from "@forma/shared/model";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { INLINE_CODE_CONTEXT_PLACEHOLDER, type CodeContextDraft } from "../lib/codeContext";
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
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { usePreviewWorkspaceStore } from "../previewWorkspaceStore";
import { __resetProjectFileReadCacheForTests } from "../lib/projectFileReadCache";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { __resetDiffFileEditorPaneSessionCacheForTests } from "./DiffFileEditorPane";
import { __resetWorkspaceFilesTreeSessionStateForTests } from "./WorkspaceFilesTree";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import { DEFAULT_CLIENT_SETTINGS } from "@forma/contracts/settings";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const THREAD_ID = "thread-browser-test" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const ARCHIVED_SECONDARY_THREAD_ID = "thread-secondary-project-archived" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const SECOND_PROJECT_ID = "project-2" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
const THREAD_KEY = scopedThreadKey(THREAD_REF);
const UUID_ROUTE_RE = /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_DRAFT_KEY = `${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`;
const FILE_VERSION_A = "a".repeat(64);
const FILE_VERSION_B = "b".repeat(64);
const PROJECT_LOGICAL_KEY = deriveLogicalProjectKeyFromSettings(
  {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: PROJECT_ID,
    cwd: "/repo/project",
    repositoryIdentity: null,
  },
  {
    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingOverrides,
  },
);
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>";
const ADD_PROJECT_SUBMENU_PLACEHOLDER = "Enter path (e.g. ~/projects/my-app)";

function swallowPreviewDrawerUnhandledRejection(event: PromiseRejectionEvent) {
  // Preview drawer mount currently triggers an empty-object rejection through
  // the browser/ws test harness path even though the visible UI state is
  // correct. Swallow it here so the interaction regression stays actionable.
  event.preventDefault();
}

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
    keybindingsConfigPath: "/repo/project/.forma-keybindings.json",
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
      logsDirectoryPath: "/repo/project/.forma/logs",
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

function createMockEnvironmentApi(input: {
  browse: EnvironmentApi["filesystem"]["browse"];
  dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"];
  createDirectory?: EnvironmentApi["projects"]["createDirectory"];
  deleteEntry?: EnvironmentApi["projects"]["deleteEntry"];
  getFullThreadDiff?: EnvironmentApi["orchestration"]["getFullThreadDiff"];
  getLocalAgentInventory?: EnvironmentApi["projects"]["getLocalAgentInventory"];
  listEntries?: EnvironmentApi["projects"]["listEntries"];
  preview?: Partial<EnvironmentApi["preview"]>;
  getTurnDiff?: EnvironmentApi["orchestration"]["getTurnDiff"];
  readFile?: EnvironmentApi["projects"]["readFile"];
  renameEntry?: EnvironmentApi["projects"]["renameEntry"];
  searchEntries?: EnvironmentApi["projects"]["searchEntries"];
  subscribeThread?: EnvironmentApi["orchestration"]["subscribeThread"];
  writeFile?: EnvironmentApi["projects"]["writeFile"];
}): EnvironmentApi {
  return {
    terminal: {} as EnvironmentApi["terminal"],
    projects: {
      listEntries:
        input.listEntries ??
        ((async () => ({
          entries: [],
        })) as EnvironmentApi["projects"]["listEntries"]),
      getLocalAgentInventory:
        input.getLocalAgentInventory ??
        ((async () => ({
          skills: [],
          commands: [],
        })) as EnvironmentApi["projects"]["getLocalAgentInventory"]),
      createDirectory:
        input.createDirectory ??
        ((async ({ relativePath }) => ({
          relativePath,
        })) as EnvironmentApi["projects"]["createDirectory"]),
      renameEntry:
        input.renameEntry ??
        ((async ({ fromRelativePath, toRelativePath }) => ({
          fromRelativePath,
          toRelativePath,
          kind: "file",
        })) as EnvironmentApi["projects"]["renameEntry"]),
      deleteEntry:
        input.deleteEntry ??
        ((async ({ relativePath }) => ({
          relativePath,
          kind: "file",
        })) as EnvironmentApi["projects"]["deleteEntry"]),
      readFile:
        input.readFile ??
        ((() => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["projects"]["readFile"]),
      searchEntries:
        input.searchEntries ??
        ((async () => ({
          entries: [],
          truncated: false,
        })) as EnvironmentApi["projects"]["searchEntries"]),
      writeFile:
        input.writeFile ??
        ((() => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["projects"]["writeFile"]),
    },
    preview: {
      inspectProject:
        input.preview?.inspectProject ??
        ((async ({ projectId }) => ({
          projectId,
          provider: "componentHarness",
          status: "ready",
          framework: "react-vite",
          bootstrapFilesPresent: true,
          summary: "Component preview is ready.",
        })) as EnvironmentApi["preview"]["inspectProject"]),
      searchComponents:
        input.preview?.searchComponents ??
        ((async () => ({
          components: [],
          truncated: false,
        })) as EnvironmentApi["preview"]["searchComponents"]),
      resolveTarget:
        input.preview?.resolveTarget ??
        ((async ({ relativePath }) => ({
          status: "notFound",
          relativePath,
        })) as EnvironmentApi["preview"]["resolveTarget"]),
      prepareBootstrapThread:
        input.preview?.prepareBootstrapThread ??
        ((async () => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["preview"]["prepareBootstrapThread"]),
      preparePreviewGenerationTurn:
        input.preview?.preparePreviewGenerationTurn ??
        ((async () => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["preview"]["preparePreviewGenerationTurn"]),
      preparePreviewRepairTurn:
        input.preview?.preparePreviewRepairTurn ??
        ((async () => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["preview"]["preparePreviewRepairTurn"]),
      ensureRuntime:
        input.preview?.ensureRuntime ??
        ((async ({ projectId }) => ({
          projectId,
          provider: "componentHarness",
          started: true,
          iframeBasePath: "/__preview/project",
        })) as EnvironmentApi["preview"]["ensureRuntime"]),
      issueAccessToken:
        input.preview?.issueAccessToken ??
        ((async ({ projectId }) => ({
          projectId,
          accessToken: "preview-token",
        })) as EnvironmentApi["preview"]["issueAccessToken"]),
      stopRuntime:
        input.preview?.stopRuntime ??
        ((async () => undefined) as EnvironmentApi["preview"]["stopRuntime"]),
      subscribeProject:
        input.preview?.subscribeProject ??
        ((() => () => undefined) as EnvironmentApi["preview"]["subscribeProject"]),
    },
    filesystem: {
      browse: input.browse,
    },
    sourceControl: {} as EnvironmentApi["sourceControl"],
    git: {} as EnvironmentApi["git"],
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      getTurnDiff:
        input.getTurnDiff ??
        ((() => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["orchestration"]["getTurnDiff"]),
      getFullThreadDiff:
        input.getFullThreadDiff ??
        ((() => {
          throw new Error("Not implemented in browser test.");
        }) as EnvironmentApi["orchestration"]["getFullThreadDiff"]),
      subscribeShell: (() => () => undefined) as EnvironmentApi["orchestration"]["subscribeShell"],
      subscribeThread:
        input.subscribeThread ??
        ((() => () => undefined) as EnvironmentApi["orchestration"]["subscribeThread"]),
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

function createCodeContext(input: {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): CodeContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    filePath: input.filePath,
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
        previewWorkspaceRecords: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
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
        turnQueue: {
          items: [],
          status: "idle",
          pauseReason: null,
        },
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
        turnQueue: {
          items: [],
          status: "idle",
          pauseReason: null,
        },
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
    queuedTurnCount: thread.turnQueue.items.length,
    turnQueueStatus: thread.turnQueue.status,
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

function clearWelcomeBootstrapTargets(nextFixture: TestFixture): void {
  nextFixture.welcome = {
    environment: nextFixture.welcome.environment,
    cwd: nextFixture.welcome.cwd,
    projectName: nextFixture.welcome.projectName,
  };
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
          turnQueue: {
            items: [],
            status: "idle",
            pauseReason: null,
          },
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
          turnQueue: {
            items: [],
            status: "idle",
            pauseReason: null,
          },
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
        previewWorkspaceRecords: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function setThreadLatestUserMessageAt(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  createdAt: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }

      const lastUserMessageIndex = thread.messages.findLastIndex(
        (message) => message.role === "user",
      );
      if (lastUserMessageIndex < 0) {
        return {
          ...thread,
          updatedAt: createdAt,
        };
      }

      return {
        ...thread,
        updatedAt: createdAt,
        messages: thread.messages.map((message, index) =>
          index === lastUserMessageIndex
            ? { ...message, createdAt, updatedAt: createdAt }
            : message,
        ),
      };
    }),
  };
}

function createSnapshotWithGroupedCleanupThreads(): OrchestrationReadModel {
  const staleAt = isoDaysAgo(5);
  const repositoryIdentity = {
    canonicalKey: "github.com/acme/project",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/project.git",
    },
    rootPath: "/repo/project",
    displayName: "Acme Project",
    provider: "github",
    owner: "acme",
    name: "project",
  };
  const baseSnapshot = setThreadLatestUserMessageAt(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-grouped-cleanup-target" as MessageId,
      targetText: "grouped cleanup target",
    }),
    THREAD_ID,
    staleAt,
  );

  return {
    ...baseSnapshot,
    projects: [
      {
        ...baseSnapshot.projects[0]!,
        title: "App",
        workspaceRoot: "/repo/project/app",
        repositoryIdentity,
      },
      {
        id: SECOND_PROJECT_ID,
        title: "Docs",
        workspaceRoot: "/repo/project/docs",
        repositoryIdentity,
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        previewWorkspaceRecords: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      ...baseSnapshot.threads,
      {
        id: "thread-grouped-cleanup" as ThreadId,
        projectId: SECOND_PROJECT_ID,
        title: "Docs stale thread",
        modelSelection: { provider: "codex", model: "gpt-5" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "docs/cleanup",
        worktreePath: null,
        latestTurn: null,
        createdAt: staleAt,
        updatedAt: staleAt,
        archivedAt: null,
        deletedAt: null,
        messages: [
          {
            id: "msg-user-grouped-cleanup-secondary" as MessageId,
            role: "user",
            text: "grouped stale thread",
            turnId: null,
            streaming: false,
            createdAt: staleAt,
            updatedAt: staleAt,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        turnQueue: {
          items: [],
          status: "idle",
          pauseReason: null,
        },
        session: {
          threadId: "thread-grouped-cleanup" as ThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: staleAt,
        },
      },
    ],
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

function createSnapshotWithAssistantFileLink(options?: {
  turnLinked?: boolean;
  workspaceFilePath?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-file-link-target" as MessageId,
    targetText: "chat file link thread",
  });
  const turnLinked = options?.turnLinked ?? true;
  const workspaceFilePath = options?.workspaceFilePath ?? "/repo/project/src/linked.ts";
  const assistantMessageId = "msg-assistant-21" as MessageId;
  const turnId = "turn-linked-editor" as TurnId;

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    turnId: turnLinked ? turnId : null,
                    text: `Open [linked.ts](file://${workspaceFilePath}#L4C2)`,
                  }
                : message,
            ),
            latestTurn: turnLinked
              ? {
                  turnId,
                  state: "completed",
                  requestedAt: isoAt(1_000),
                  startedAt: isoAt(1_001),
                  completedAt: isoAt(1_010),
                  assistantMessageId,
                }
              : null,
            checkpoints: turnLinked
              ? [
                  {
                    turnId,
                    completedAt: isoAt(1_010),
                    status: "ready",
                    checkpointTurnCount: 1,
                    checkpointRef: CheckpointRef.make("checkpoint-linked-editor"),
                    assistantMessageId,
                    files: [
                      {
                        path: "src/linked.ts",
                        kind: "modified",
                        additions: 1,
                        deletions: 0,
                      },
                    ],
                  },
                ]
              : [],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  updatedAt: isoAt(1_010),
                }
              : null,
            updatedAt: isoAt(1_010),
          }
        : thread,
    ),
  };
}

function mockLocalWorkspaceEditorEnvironmentApi(options?: {
  diff?: string;
  relativePath?: string;
  contents?: string;
}) {
  const readFile = vi.fn(async () => ({
    relativePath: options?.relativePath ?? "src/linked.ts",
    contents: options?.contents ?? "export const linked = true;\n",
    version: FILE_VERSION_A,
  }));
  const writeFile = vi.fn(async () => ({
    relativePath: options?.relativePath ?? "src/linked.ts",
    version: FILE_VERSION_B,
  }));

  __setEnvironmentApiOverrideForTests(
    LOCAL_ENVIRONMENT_ID,
    createMockEnvironmentApi({
      browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
      dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
      getFullThreadDiff: vi.fn(async () => ({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: options?.diff ?? "",
      })),
      getTurnDiff: vi.fn(async () => ({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: options?.diff ?? "",
      })),
      readFile,
      writeFile,
    }),
  );

  return { readFile, writeFile };
}

function createSnapshotWithQueuedTurns(options?: {
  status?: "queued" | "paused";
  pauseReason?: "interrupted" | "error" | null;
  items?: Array<{
    messageId: MessageId;
    text: string;
    attachmentIds?: string[];
    interactionMode?: "default" | "ask" | "plan";
    runtimeMode?: "approval-required" | "full-access";
  }>;
  includeRunningTurn?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-queue-target" as MessageId,
    targetText: "queue browser thread",
    sessionStatus: options?.includeRunningTurn === false ? "ready" : "running",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn:
              options?.includeRunningTurn === false
                ? null
                : {
                    turnId: "turn-running-browser" as TurnId,
                    state: "running",
                    requestedAt: isoAt(40),
                    startedAt: isoAt(41),
                    completedAt: null,
                    assistantMessageId: null,
                  },
            turnQueue: {
              items: (options?.items ?? []).map((item, index) => ({
                messageId: item.messageId,
                text: item.text,
                attachmentIds: item.attachmentIds ?? [],
                modelSelection: {
                  provider: "codex" as const,
                  model: index === 0 ? "gpt-5.3-codex" : "gpt-5-codex",
                },
                runtimeMode: item.runtimeMode ?? "approval-required",
                interactionMode: item.interactionMode ?? "plan",
                titleSeed: item.text,
                sourceProposedPlan: null,
                queuedAt: isoAt(50 + index),
              })),
              status: options?.status ?? ((options?.items?.length ?? 0) > 0 ? "queued" : "idle"),
              pauseReason:
                (options?.status ?? ((options?.items?.length ?? 0) > 0 ? "queued" : "idle")) ===
                "paused"
                  ? (options?.pauseReason ?? "error")
                  : null,
            },
            session: {
              ...thread.session!,
              status: options?.includeRunningTurn === false ? "ready" : "running",
              activeTurnId:
                options?.includeRunningTurn === false ? null : ("turn-running-browser" as TurnId),
            },
            updatedAt: isoAt(60),
          }
        : thread,
    ),
    updatedAt: isoAt(60),
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
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      sequence: fixture.snapshot.snapshotSequence + 1,
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
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]'),
    "Unable to find send button.",
  );
}

async function waitForActionButton(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    `Unable to find "${label}" action button.`,
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

function countBodyOccurrences(text: string): number {
  return (document.body.textContent ?? "").split(text).length - 1;
}

function findStickyMessageContainer(messageRow: HTMLElement | null): HTMLElement | null {
  let current = messageRow?.parentElement ?? null;
  while (current && current !== document.body) {
    if (getComputedStyle(current).position === "sticky") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function emitThreadDetailEvent(event: OrchestrationEvent): void {
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
    kind: "event",
    event,
  });
}

function emitThreadSnapshot(threadId: ThreadId = THREAD_ID): void {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Unable to find thread snapshot for ${threadId}.`);
  }
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: fixture.snapshot.snapshotSequence,
      thread,
    },
  });
}

async function waitForMessageRow(messageId: MessageId): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`),
    `Unable to find message row "${messageId}".`,
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

async function waitForComposerAddActionsButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Add composer action"]'),
    'Unable to find "Add composer action" button.',
  );
}

async function openComposerAddActionsMenu(): Promise<void> {
  const trigger = await waitForComposerAddActionsButton();
  trigger.click();
  await waitForLayout();
}

async function waitForComposerAddActionsMenuItem(label: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find((item) =>
        item.textContent?.includes(label),
      ) ?? null,
    `Unable to find composer action menu item "${label}".`,
  );
}

async function waitForComposerInteractionModePill(
  expectedLabel: "Agent" | "Ask" | "Plan",
): Promise<HTMLElement> {
  return waitForElement(() => {
    const pill = document.querySelector<HTMLElement>("[data-composer-interaction-mode-pill]");
    return pill?.textContent?.includes(expectedLabel) ? pill : null;
  }, `Unable to find ${expectedLabel} interaction mode pill.`);
}

async function waitForComposerImageUploadInput(): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector<HTMLInputElement>('[data-composer-image-upload-input="true"]'),
    "Unable to find composer image upload input.",
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

function dispatchSidebarToggleShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "b",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function createDesktopBridgeMenuActionStub(): {
  bridge: DesktopBridge;
  emitMenuAction: (action: "open-settings" | "toggle-sidebar") => void;
} {
  let menuActionListener: ((action: "open-settings" | "toggle-sidebar") => void) | null = null;
  const idleUpdateState = {
    enabled: false,
    status: "idle" as const,
    channel: "latest" as const,
    currentVersion: "0.0.0-test",
    hostArch: "arm64" as const,
    appArch: "arm64" as const,
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  return {
    bridge: {
      getAppBranding: vi.fn().mockReturnValue(null),
      getLocalEnvironmentBootstrap: vi.fn().mockReturnValue({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
      getClientSettings: vi.fn().mockResolvedValue(null),
      setClientSettings: vi.fn().mockResolvedValue(undefined),
      getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
      setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
      getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
      setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
      removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
      getServerExposureState: vi.fn().mockResolvedValue({
        mode: "local-only" as const,
        endpointUrl: null,
        advertisedHost: null,
      }),
      setServerExposureMode: vi.fn().mockResolvedValue({
        mode: "local-only" as const,
        endpointUrl: null,
        advertisedHost: null,
      }),
      pickFolder: vi.fn().mockResolvedValue(null),
      confirm: vi.fn().mockResolvedValue(false),
      setTheme: vi.fn().mockResolvedValue(undefined),
      showContextMenu: vi.fn().mockResolvedValue(null),
      openExternal: vi.fn().mockResolvedValue(true),
      notifyThreadAttention: vi.fn().mockResolvedValue(false),
      onThreadAttentionActivated: () => () => {},
      onMenuAction: (listener) => {
        menuActionListener = listener;
        return () => {
          if (menuActionListener === listener) {
            menuActionListener = null;
          }
        };
      },
      getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
      setUpdateChannel: vi.fn().mockResolvedValue(idleUpdateState),
      checkForUpdate: vi.fn().mockResolvedValue({
        checked: false,
        state: idleUpdateState,
      }),
      downloadUpdate: vi.fn().mockResolvedValue({
        accepted: false,
        completed: false,
        state: idleUpdateState,
      }),
      installUpdate: vi.fn().mockResolvedValue({
        accepted: false,
        completed: false,
        state: idleUpdateState,
      }),
      onUpdateState: () => () => {},
    },
    emitMenuAction: (action) => {
      menuActionListener?.(action);
    },
  };
}

function releaseModShortcut(key?: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: key ?? (isMacPlatform(navigator.platform) ? "Meta" : "Control"),
      metaKey: false,
      ctrlKey: false,
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

async function waitForDesktopSidebarCollapseTrigger(): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      document.querySelector(
        '[data-testid="desktop-sidebar-collapse-trigger"]',
      ) as HTMLButtonElement | null,
    "Desktop sidebar collapse trigger did not render.",
  );
}

async function waitForDesktopSidebarReopenTrigger(): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      document.querySelector(
        'header [data-testid="desktop-sidebar-reopen-trigger"]',
      ) as HTMLButtonElement | null,
    "Desktop sidebar reopen trigger did not render in the header.",
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

async function waitForCommandPaletteInput(placeholder: string): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null,
    `Command palette input with placeholder "${placeholder}" did not render.`,
  );
}

function getCommandPaletteLegendEntries(): string[] {
  const footer = document.querySelector('[data-slot="command-footer"]');
  if (!footer) {
    return [];
  }

  return Array.from(footer.querySelectorAll('[data-slot="kbd-group"]'))
    .map((group) =>
      Array.from(group.children)
        .map((child) => child.textContent?.trim() ?? "")
        .filter((value) => value.length > 0)
        .join(" "),
    )
    .filter((value) => value.length > 0);
}

async function dispatchInputKey(
  input: HTMLInputElement,
  init: Pick<KeyboardEventInit, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): Promise<void> {
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await waitForLayout();
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
    __resetEnvironmentApiOverridesForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    Reflect.deleteProperty(window, "desktopBridge");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useCommandPaletteStore.setState({
      open: false,
      openIntent: null,
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
    useBottomDrawerUiStore.persist.clearStorage();
    useBottomDrawerUiStore.setState({
      visibleMode: "hidden",
      previousVisibleMode: null,
      sharedHeight: 320,
    });
    usePreviewWorkspaceStore.setState({
      activeProjectRef: null,
      projectStateByKey: {},
    });
    __resetProjectFileReadCacheForTests();
    __resetDiffFileEditorPaneSessionCacheForTests();
    __resetWorkspaceFilesTreeSessionStateForTests();
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
  });
  it("re-expands the bootstrap project using its logical key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_LOGICAL_KEY]: false,
      },
      projectOrder: [PROJECT_LOGICAL_KEY],
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
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
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

  it("shows the no-active-thread home surface for projectless workspaces and opens add project browse mode", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await expect
        .element(page.getByTestId("no-active-thread-action-add-project"))
        .toBeInTheDocument();

      await page.getByTestId("no-active-thread-action-add-project").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists projects on the no-active-thread home surface and creates a thread from a project row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      await expect
        .element(page.getByTestId("no-active-thread-action-new-thread"))
        .toBeInTheDocument();
      await page.getByTestId(`no-active-thread-project-row-${PROJECT_ID}`).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project row.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);

      expect(draftThread?.projectId).toBe(PROJECT_ID);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists recent threads on the no-active-thread home surface and opens a selected thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-no-active-thread-recent" as MessageId,
        targetText: "no active thread recent",
      }),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      await expect.element(page.getByText("Recent threads", { exact: true })).toBeInTheDocument();
      await page.getByTestId(`no-active-thread-thread-row-${THREAD_ID}`).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "Route should have changed to the selected recent thread.",
      );

      expect(nextPath).toBe(serverThreadPath(THREAD_ID));
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies UI font sizing to the recent threads table headers", async () => {
    localStorage.setItem(
      "forma:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        uiFontScale: 19,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-no-active-thread-header-font" as MessageId,
        targetText: "no active thread header font",
      }),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      await expect
        .element(page.getByTestId("no-active-thread-recent-threads-header-thread"))
        .toBeVisible();
      await vi.waitFor(() => {
        const threadHeader = document.querySelector<HTMLElement>(
          '[data-testid="no-active-thread-recent-threads-header-thread"]',
        );
        const actionsHeader = document.querySelector<HTMLElement>(
          '[data-testid="no-active-thread-recent-threads-header-actions"]',
        );
        const expectedFontSize = getComputedStyle(document.documentElement)
          .getPropertyValue("--app-ui-text-2xs")
          .trim();

        expect(threadHeader).not.toBeNull();
        expect(actionsHeader).not.toBeNull();
        expect(getComputedStyle(threadHeader!).fontSize).toBe(expectedFontSize);
        expect(getComputedStyle(actionsHeader!).fontSize).toBe(expectedFontSize);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reveals no-active-thread recent-thread quick actions on hover and does not navigate when showing archive confirmation", async () => {
    localStorage.setItem(
      "forma:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        confirmThreadArchive: true,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-no-active-thread-hover-actions" as MessageId,
        targetText: "no active thread hover actions",
      }),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      const threadRow = page.getByTestId(`no-active-thread-thread-row-${THREAD_ID}`);
      const actionRail = `[data-testid="no-active-thread-thread-actions-${THREAD_ID}"]`;
      await threadRow.hover();
      await vi.waitFor(
        () => {
          const rail = document.querySelector<HTMLElement>(actionRail);
          expect(rail).not.toBeNull();
          expect(window.getComputedStyle(rail!).opacity).toBe("1");
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByTestId(`no-active-thread-thread-archive-${THREAD_ID}`).click();
      await expect
        .element(page.getByTestId(`no-active-thread-thread-archive-confirm-${THREAD_ID}`))
        .toBeVisible();
      expect(mounted.router.state.location.pathname).toBe("/");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the no-active-thread recent-thread ellipsis menu without navigating and runs mark unread", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-no-active-thread-menu-actions" as MessageId,
      targetText: "no active thread menu actions",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: {
                  turnId: "turn-no-active-thread-menu" as TurnId,
                  state: "completed",
                  requestedAt: isoAt(1_000),
                  startedAt: isoAt(1_001),
                  completedAt: isoAt(1_010),
                  assistantMessageId: null,
                },
                updatedAt: isoAt(1_010),
              }
            : thread,
        ),
      },
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      const threadRow = page.getByTestId(`no-active-thread-thread-row-${THREAD_ID}`);
      await threadRow.hover();
      await page.getByTestId(`no-active-thread-thread-menu-trigger-${THREAD_ID}`).click();

      await expect.element(page.getByRole("menuitem", { name: "Mark unread" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Copy thread ID" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
      await expect
        .element(page.getByText("Rename thread", { exact: true }))
        .not.toBeInTheDocument();

      await page.getByRole("menuitem", { name: "Mark unread" }).click();
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().threadLastVisitedAtById[THREAD_KEY]).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe("/");
    } finally {
      await mounted.cleanup();
    }
  });

  it("forks a recent thread from the no-active-thread menu and opens the copied history", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-no-active-thread-fork" as MessageId,
      targetText: "fork source history",
    });
    const desktopBridge = createDesktopBridgeMenuActionStub();
    window.desktopBridge = desktopBridge.bridge;
    let forkedThreadId: ThreadId | null = null;
    const dispatchCommand = vi.fn(
      async (command: Parameters<EnvironmentApi["orchestration"]["dispatchCommand"]>[0]) => {
        if (command.type !== "thread.fork") {
          return { sequence: fixture.snapshot.snapshotSequence };
        }

        forkedThreadId = command.threadId;
        const sourceThread = fixture.snapshot.threads.find(
          (thread) => thread.id === command.sourceThreadId,
        );
        if (!sourceThread) {
          throw new Error("Missing source thread.");
        }

        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          updatedAt: NOW_ISO,
          threads: [
            ...fixture.snapshot.threads,
            {
              ...sourceThread,
              id: command.threadId,
              title: `${sourceThread.title} (fork)`,
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
              session: null,
              turnQueue: {
                items: [],
                status: "idle",
                pauseReason: null,
              },
              checkpoints: [],
            },
          ],
        };
        return { sequence: fixture.snapshot.snapshotSequence };
      },
    );

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand,
        subscribeThread: ((input, callback) => {
          const timer = window.setTimeout(() => {
            const thread = fixture.snapshot.threads.find((entry) => entry.id === input.threadId);
            if (!thread) {
              return;
            }
            callback({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: fixture.snapshot.snapshotSequence,
                thread,
              },
            });
          }, 0);
          return () => {
            window.clearTimeout(timer);
          };
        }) as EnvironmentApi["orchestration"]["subscribeThread"],
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      const threadRow = page.getByTestId(`no-active-thread-thread-row-${THREAD_ID}`);
      await threadRow.hover();
      await page.getByTestId(`no-active-thread-thread-menu-trigger-${THREAD_ID}`).click();

      await expect.element(page.getByRole("menuitem", { name: "Fork thread" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Fork thread" }).click();

      await vi.waitFor(
        () => {
          expect(dispatchCommand).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "thread.fork",
              sourceThreadId: THREAD_ID,
            }),
          );
          expect(forkedThreadId).not.toBeNull();
          expect(mounted.router.state.location.pathname).toBe(serverThreadPath(forkedThreadId!));
          expect(document.body.textContent).toContain("filler user message 21");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the new-thread-in command palette submenu from the no-active-thread home surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      initialPath: "/",
      configureFixture: clearWelcomeBootstrapTargets,
    });

    try {
      await waitForServerConfigToApply();
      await page.getByTestId("no-active-thread-action-new-thread").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await waitForCommandPaletteInput("Search...");
      await expect.element(palette.getByText("Projects", { exact: true })).toBeInTheDocument();
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses the desktop sidebar and reopens it from the chat header", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-collapse" as MessageId,
        targetText: "sidebar collapse",
      }),
    });

    try {
      const sidebar = await waitForElement(
        () =>
          document.querySelector(
            "[data-slot='sidebar'][data-side='left']",
          ) as HTMLDivElement | null,
        "Desktop sidebar did not render.",
      );
      expect(sidebar.dataset.state).toBe("expanded");

      const collapseTrigger = await waitForDesktopSidebarCollapseTrigger();
      await collapseTrigger.click();
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("collapsed");
        },
        { timeout: 8_000, interval: 16 },
      );

      const reopenTrigger = await waitForDesktopSidebarReopenTrigger();
      await expect.element(reopenTrigger).toBeVisible();
      await reopenTrigger.click();
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("expanded");
          expect(
            document.querySelector('[data-testid="desktop-sidebar-reopen-trigger"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the desktop sidebar from the global keyboard shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-shortcut" as MessageId,
        targetText: "sidebar shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "sidebar.toggle",
              shortcut: {
                key: "b",
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
      const sidebar = await waitForElement(
        () =>
          document.querySelector(
            "[data-slot='sidebar'][data-side='left']",
          ) as HTMLDivElement | null,
        "Desktop sidebar did not render.",
      );
      expect(sidebar.dataset.state).toBe("expanded");

      dispatchSidebarToggleShortcut();
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("collapsed");
        },
        { timeout: 8_000, interval: 16 },
      );

      dispatchSidebarToggleShortcut();
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("expanded");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the desktop sidebar from native menu actions", async () => {
    const desktopBridge = createDesktopBridgeMenuActionStub();
    window.desktopBridge = desktopBridge.bridge;

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-menu-action" as MessageId,
        targetText: "sidebar menu action",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const sidebar = await waitForElement(
        () =>
          document.querySelector(
            "[data-slot='sidebar'][data-side='left']",
          ) as HTMLDivElement | null,
        "Desktop sidebar did not render.",
      );
      expect(sidebar.dataset.state).toBe("expanded");

      desktopBridge.emitMenuAction("toggle-sidebar");
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("collapsed");
        },
        { timeout: 8_000, interval: 16 },
      );

      desktopBridge.emitMenuAction("toggle-sidebar");
      await vi.waitFor(
        () => {
          expect(sidebar.dataset.state).toBe("expanded");
        },
        { timeout: 8_000, interval: 16 },
      );
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
              FORMA_PROJECT_ROOT: "/repo/project",
            },
          });
          expect(openRequest?.env?.FORMA_WORKTREE_PATH).toBeUndefined();
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

  it("shows Kiro in the open picker menu and opens the project cwd with it", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["kiro"],
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

      const kiroItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Kiro"),
          ) ?? null,
        "Unable to find Kiro menu item.",
      );
      (kiroItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "kiro",
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
    localStorage.setItem("forma:last-editor", JSON.stringify("vscodium"));
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
              FORMA_PROJECT_ROOT: "/repo/project",
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
              FORMA_PROJECT_ROOT: "/repo/project",
              FORMA_WORKTREE_PATH: "/repo/worktrees/feature-draft",
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
              url: "https://github.com/pingdotgg/forma/pull/1359",
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
              url: "https://github.com/pingdotgg/forma/pull/1359",
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
                branch: expect.stringMatching(/^forma\/[0-9a-f]{8}$/),
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
                branch: expect.stringMatching(/^forma\/[0-9a-f]{8}$/),
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
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      await waitForComposerAddActionsButton();
      await waitForComposerInteractionModePill("Agent");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      await waitForComposerInteractionModePill("Agent");

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

      await waitForComposerInteractionModePill("Plan");

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForComposerInteractionModePill("Agent");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the plus action button with a default Agent pill in wide footer mode", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-wide-plus" as MessageId,
        targetText: "wide plus target",
      }),
    });

    try {
      await waitForComposerAddActionsButton();
      await waitForComposerInteractionModePill("Agent");
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects plan mode from the plus menu and switches it back to Agent", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-plan-pill" as MessageId,
        targetText: "plan pill target",
      }),
    });

    try {
      await openComposerAddActionsMenu();
      const planItem = await waitForComposerAddActionsMenuItem("Plan");
      planItem.click();

      await waitForComposerInteractionModePill("Plan");

      await openComposerAddActionsMenu();
      const buildItem = await waitForComposerAddActionsMenuItem("Agent");
      buildItem.click();

      await waitForComposerInteractionModePill("Agent");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the plus menu from the interaction mode pill", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-mode-pill-trigger" as MessageId,
        targetText: "mode pill trigger target",
      }),
    });

    try {
      const addActionsButton = await waitForComposerAddActionsButton();
      const pill = await waitForComposerInteractionModePill("Agent");
      pill.click();

      const planItem = await waitForComposerAddActionsMenuItem("Plan");
      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="menu-popup"]'),
        "Unable to find composer add actions popup.",
      );

      await vi.waitFor(
        () => {
          const popupRect = popup.getBoundingClientRect();
          const addActionsRect = addActionsButton.getBoundingClientRect();
          const pillRect = pill.getBoundingClientRect();

          expect(Math.abs(popupRect.left - addActionsRect.left)).toBeLessThan(
            Math.abs(popupRect.left - pillRect.left),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      planItem.click();
      await waitForComposerInteractionModePill("Plan");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps ask mode selected from the plus menu on the active thread until the next send", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-ask-thread" as MessageId,
        targetText: "ask thread target",
      }),
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
      wsRequests.length = 0;

      await openComposerAddActionsMenu();
      const askItem = await waitForComposerAddActionsMenuItem("Ask");
      askItem.click();

      await waitForComposerInteractionModePill("Ask");

      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Explain the current thread only");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const runtimeModeSet = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.runtime-mode.set",
          ) as
            | {
                _tag: string;
                type?: string;
                threadId?: string;
                runtimeMode?: string;
              }
            | undefined;
          const interactionModeSet = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.interaction-mode.set",
          ) as
            | {
                _tag: string;
                type?: string;
                threadId?: string;
                interactionMode?: string;
              }
            | undefined;
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                threadId?: string;
                runtimeMode?: string;
                interactionMode?: string;
              }
            | undefined;

          expect(runtimeModeSet).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.runtime-mode.set",
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
          });
          expect(interactionModeSet).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.interaction-mode.set",
            threadId: THREAD_ID,
            interactionMode: "ask",
          });
          expect(turnStart).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
            interactionMode: "ask",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("inserts a raw skill trigger from the plus menu and opens skill suggestions", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-plus-skill" as MessageId,
        targetText: "plus skill target",
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
      await openComposerAddActionsMenu();
      const skillItem = await waitForComposerAddActionsMenuItem("Skill");
      skillItem.click();

      await waitForComposerText("$");
      await waitForComposerMenuItem("skill:codex:agent-browser");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the hidden image upload input from the plus menu", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-plus-image" as MessageId,
        targetText: "plus image target",
      }),
    });

    try {
      const imageInput = await waitForComposerImageUploadInput();
      const handleImageInputClick = vi.fn();
      imageInput.addEventListener("click", handleImageInputClick);

      await openComposerAddActionsMenu();
      const imageItem = await waitForComposerAddActionsMenuItem("Image");
      imageItem.click();

      await vi.waitFor(
        () => {
          expect(handleImageInputClick).toHaveBeenCalledTimes(1);
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

  it("creates a manual branch from the branch picker", async () => {
    const activeDraftId = draftIdFromPath("/draft/draft-manual-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [activeDraftId]: {
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
        if (body._tag === WS_METHODS.gitCreateBranch) {
          return { branch: body.branch };
        }
        return undefined;
      },
    });

    try {
      await page.getByText("main", { exact: true }).click();
      await page.getByRole("button", { name: "New branch" }).click();
      await page.getByLabelText("Branch name", { exact: true }).fill("feature/manual-branch");
      await page.getByRole("button", { name: "Create branch" }).click();

      await vi.waitFor(
        () => {
          const createRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateBranch,
          );
          expect(createRequest).toMatchObject({
            _tag: WS_METHODS.gitCreateBranch,
            cwd: "/repo/project",
            branch: "feature/manual-branch",
            checkout: true,
          });
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "feature/manual-branch",
          );
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

  it("sends attached code contexts and hides the raw code_context block in the visible timeline", async () => {
    useComposerDraftStore.getState().addCodeContext(
      THREAD_REF,
      createCodeContext({
        id: "code-context-send",
        filePath: "src/example.ts",
        lineStart: 7,
        lineEnd: 8,
        text: "const a = 1;\nconst b = 2;",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_REF, `review ${INLINE_CODE_CONTEXT_PLACEHOLDER} please`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-code-context-send" as MessageId,
        targetText: "code context send target",
      }),
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
                message?: {
                  text?: string;
                };
              }
            | undefined;

          expect(turnStartRequest?.message?.text).toContain("#src/example.ts:7-8");
          expect(turnStartRequest?.message?.text).toContain("<code_context>");
          expect(turnStartRequest?.message?.text).toContain("- src/example.ts lines 7-8:");
          expect(document.body.textContent).toContain("example.ts lines 7-8");
          expect(document.body.textContent).not.toContain("<code_context>");
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
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Interrupt turn"]'),
        "Unable to find interrupt button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps queued requests in the queue panel while a turn is running", async () => {
    const queuedPrompt = "browser queued prompt only";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithQueuedTurns({
        items: [
          {
            messageId: "queued-browser-1" as MessageId,
            text: queuedPrompt,
          },
        ],
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-message-id="queued-browser-1"]')).toBeNull();
          expect(document.querySelector('[data-composer-queue-panel="true"]')).toBeTruthy();
          expect(document.body.textContent).toContain("1 queued");
          expect(document.body.textContent).toContain(queuedPrompt);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches resume and remove queue commands from the paused queue panel", async () => {
    const queuedMessageId = "queued-paused-1" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithQueuedTurns({
        status: "paused",
        pauseReason: "error",
        items: [
          {
            messageId: queuedMessageId,
            text: "Paused queued prompt",
          },
        ],
      }),
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
      (await waitForButtonByText("Resume queue")).click();
      (
        await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[title="Remove queued turn"]'),
          'Unable to find "Remove queued turn" queue action.',
        )
      ).click();

      await vi.waitFor(
        () => {
          const resumeRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.queue.resume",
          );
          const removeRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.queue.remove" &&
              request.messageId === queuedMessageId,
          );

          expect(resumeRequest).toBeTruthy();
          expect(removeRequest).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds prompts to the queue while running without creating an optimistic timeline copy", async () => {
    const queuedPrompt = "queue row browser send";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithQueuedTurns(),
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
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill(queuedPrompt);
      (await waitForActionButton("Add to queue")).click();

      let dispatchRequest:
        | {
            _tag: string;
            type?: string;
            message?: {
              messageId?: MessageId;
              text?: string;
            };
          }
        | undefined;
      await vi.waitFor(
        () => {
          dispatchRequest = wsRequests.find(
            (entry) =>
              entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              entry.type === "thread.turn.start" &&
              typeof entry.message === "object" &&
              entry.message !== null &&
              "text" in entry.message &&
              (entry.message as { text?: unknown }).text === queuedPrompt,
          ) as typeof dispatchRequest;
          expect(dispatchRequest).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const composerEditor = document.querySelector<HTMLElement>(
            '[data-testid="composer-editor"]',
          );
          const composerForm = document.querySelector<HTMLElement>(
            '[data-chat-composer-form="true"]',
          );
          const queuedMessageId = dispatchRequest?.message?.messageId;
          expect(composerEditor?.textContent?.trim() ?? "").toBe("");
          expect(document.querySelector('[data-composer-queue-panel="true"]')).not.toBeNull();
          expect(queuedMessageId).toBeTruthy();
          expect(
            queuedMessageId
              ? document.querySelector(`[data-message-id="${queuedMessageId}"]`)
              : null,
          ).toBeNull();
          expect(composerForm).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const queuedTurn = {
        messageId: dispatchRequest?.message?.messageId ?? ("queued-browser-send" as MessageId),
        text: queuedPrompt,
        attachmentIds: [],
        modelSelection: {
          provider: "codex" as const,
          model: "gpt-5.3-codex",
        },
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
        titleSeed: queuedPrompt,
        sourceProposedPlan: null,
        queuedAt: isoAt(61),
      };

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                turnQueue: {
                  items: [queuedTurn],
                  status: "queued",
                  pauseReason: null,
                },
                updatedAt: isoAt(61),
              }
            : thread,
        ),
        updatedAt: isoAt(61),
      };
      emitThreadDetailEvent({
        sequence: fixture.snapshot.snapshotSequence,
        eventId: EventId.make("evt-browser-turn-enqueued"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.turn-enqueued",
        occurredAt: isoAt(61),
        commandId: CommandId.make("cmd-browser-turn-enqueued"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-browser-turn-enqueued"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          queuedTurn,
        },
      });

      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-composer-queue-panel="true"]')).toBeTruthy();
          expect(document.body.textContent).toContain("1 queued");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a sent request sticky after the turn settles", async () => {
    const sentPrompt = "sticky row immediate send";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-send-seed" as MessageId,
        targetText: "seed sticky send",
      }),
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
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill(sentPrompt);
      (await waitForSendButton()).click();

      let dispatchRequest:
        | {
            _tag: string;
            type?: string;
            message?: {
              messageId?: MessageId;
              text?: string;
            };
          }
        | undefined;
      await vi.waitFor(
        () => {
          dispatchRequest = wsRequests.find(
            (entry) =>
              entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              entry.type === "thread.turn.start" &&
              typeof entry.message === "object" &&
              entry.message !== null &&
              "text" in entry.message &&
              (entry.message as { text?: unknown }).text === sentPrompt,
          ) as typeof dispatchRequest;
          expect(dispatchRequest).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      const sentMessageId =
        dispatchRequest?.message?.messageId ?? ("sticky-sent-message" as MessageId);
      const sentTurnId = "turn-sticky-browser-send" as TurnId;
      const sentCreatedAt = isoAt(170);
      await waitForMessageRow(sentMessageId);

      await vi.waitFor(
        () => {
          const messageRow = document.querySelector<HTMLElement>(
            `[data-message-id="${sentMessageId}"]`,
          );
          const stickyContainer = findStickyMessageContainer(messageRow ?? null);
          expect(messageRow).toBeTruthy();
          expect(stickyContainer).toBeTruthy();
          expect(countBodyOccurrences(sentPrompt)).toBe(1);
          expect(getComputedStyle(stickyContainer!).position).toBe("sticky");
        },
        { timeout: 8_000, interval: 16 },
      );

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: [
                  ...thread.messages,
                  {
                    id: sentMessageId,
                    role: "user" as const,
                    text: sentPrompt,
                    turnId: sentTurnId,
                    streaming: false,
                    createdAt: sentCreatedAt,
                    updatedAt: isoAt(71),
                  },
                ],
                latestTurn: {
                  turnId: sentTurnId,
                  state: "running" as const,
                  requestedAt: sentCreatedAt,
                  startedAt: isoAt(71),
                  completedAt: null,
                  assistantMessageId: null,
                },
                session: {
                  ...thread.session!,
                  status: "running",
                  activeTurnId: sentTurnId,
                  updatedAt: isoAt(71),
                },
                updatedAt: isoAt(71),
              }
            : thread,
        ),
        updatedAt: isoAt(71),
      };
      emitThreadSnapshot();

      await vi.waitFor(
        () => {
          const messageRow = document.querySelector<HTMLElement>(
            `[data-message-id="${sentMessageId}"]`,
          );
          const stickyContainer = findStickyMessageContainer(messageRow ?? null);
          expect(messageRow).toBeTruthy();
          expect(stickyContainer).toBeTruthy();
          expect(countBodyOccurrences(sentPrompt)).toBe(1);
          expect(getComputedStyle(stickyContainer!).position).toBe("sticky");
        },
        { timeout: 8_000, interval: 16 },
      );

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: {
                  turnId: sentTurnId,
                  state: "completed" as const,
                  requestedAt: sentCreatedAt,
                  startedAt: isoAt(71),
                  completedAt: isoAt(75),
                  assistantMessageId: null,
                },
                session: {
                  ...thread.session!,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(75),
                },
                updatedAt: isoAt(75),
              }
            : thread,
        ),
        updatedAt: isoAt(75),
      };
      emitThreadSnapshot();

      await vi.waitFor(
        () => {
          const messageRow = document.querySelector<HTMLElement>(
            `[data-message-id="${sentMessageId}"]`,
          );
          const stickyContainer = findStickyMessageContainer(messageRow ?? null);
          expect(messageRow).toBeTruthy();
          expect(stickyContainer).toBeTruthy();
          expect(getComputedStyle(stickyContainer!).position).toBe("sticky");
          expect(countBodyOccurrences(sentPrompt)).toBe(1);
        },
        { timeout: 8_000, interval: 16 },
      );
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

  it("exposes the full thread title on the sidebar row tooltip", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      const threadTitle = page.getByTestId(`thread-title-${THREAD_ID}`);

      await expect.element(threadTitle).toBeInTheDocument();
      await threadTitle.hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the confirm archive action after clicking the archive button", async () => {
    localStorage.setItem(
      "forma:client-settings:v1",
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
      localStorage.removeItem("forma:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("hides the project cleanup action when no inactive threads are eligible", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: setThreadLatestUserMessageAt(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-cleanup-hidden-test" as MessageId,
          targetText: "cleanup hidden target",
        }),
        THREAD_ID,
        new Date().toISOString(),
      ),
    });

    try {
      await expect.element(page.getByTestId("new-thread-button")).toBeInTheDocument();
      expect(
        document.querySelector(`[data-testid="project-thread-cleanup-button-${PROJECT_ID}"]`),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("archives only eligible inactive threads during sidebar cleanup and creates one draft replacement", async () => {
    const staleAt = isoDaysAgo(5);
    const baseSnapshot = setThreadLatestUserMessageAt(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-cleanup-target" as MessageId,
        targetText: "cleanup target",
      }),
      THREAD_ID,
      staleAt,
    );
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: [
        ...baseSnapshot.threads,
        {
          id: "thread-cleanup-running" as ThreadId,
          projectId: PROJECT_ID,
          title: "Cleanup running thread",
          modelSelection: { provider: "codex", model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "cleanup/running",
          worktreePath: null,
          latestTurn: null,
          createdAt: staleAt,
          updatedAt: staleAt,
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: "msg-user-cleanup-running" as MessageId,
              role: "user",
              text: "running cleanup thread",
              turnId: null,
              streaming: false,
              createdAt: staleAt,
              updatedAt: staleAt,
            },
          ],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          turnQueue: {
            items: [],
            status: "idle",
            pauseReason: null,
          },
          session: {
            threadId: "thread-cleanup-running" as ThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-cleanup-running" as TurnId,
            lastError: null,
            updatedAt: staleAt,
          },
        },
        {
          id: "thread-cleanup-queued" as ThreadId,
          projectId: PROJECT_ID,
          title: "Cleanup queued thread",
          modelSelection: { provider: "codex", model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "cleanup/queued",
          worktreePath: null,
          latestTurn: null,
          createdAt: staleAt,
          updatedAt: staleAt,
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: "msg-user-cleanup-queued" as MessageId,
              role: "user",
              text: "queued cleanup thread",
              turnId: null,
              streaming: false,
              createdAt: staleAt,
              updatedAt: staleAt,
            },
          ],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          turnQueue: {
            items: [
              {
                messageId: "msg-user-cleanup-queued" as MessageId,
                text: "queued cleanup thread",
                attachmentIds: [],
                modelSelection: { provider: "codex", model: "gpt-5" },
                runtimeMode: "full-access",
                interactionMode: "default",
                titleSeed: null,
                sourceProposedPlan: null,
                queuedAt: staleAt,
              },
            ],
            status: "queued",
            pauseReason: null,
          },
          session: {
            threadId: "thread-cleanup-queued" as ThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: staleAt,
          },
        },
      ],
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const cleanupButton = page.getByTestId(`project-thread-cleanup-button-${PROJECT_ID}`);
      await expect.element(cleanupButton).toBeInTheDocument();
      await cleanupButton.click();

      await expect.element(page.getByText("Clean up threads")).toBeInTheDocument();
      await expect
        .element(page.getByTestId(`cleanup-eligible-count-${PROJECT_ID}`))
        .toHaveTextContent("1");
      await expect
        .element(page.getByTestId(`cleanup-skipped-running-count-${PROJECT_ID}`))
        .toHaveTextContent("1");
      await expect
        .element(page.getByTestId(`cleanup-skipped-queued-count-${PROJECT_ID}`))
        .toHaveTextContent("1");

      wsRequests.length = 0;
      await page.getByRole("button", { name: "Archive 1 thread" }).click();

      await vi.waitFor(
        () => {
          const archiveRequests = wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.archive",
          ) as Array<{ threadId?: ThreadId }>;
          expect(archiveRequests.map((request) => request.threadId)).toEqual([THREAD_ID]);
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const draftThreads = Object.values(
            useComposerDraftStore.getState().draftThreadsByThreadKey,
          );
          expect(draftThreads).toHaveLength(1);
          expect(draftThreads[0]?.projectId).toBe(PROJECT_ID);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("cleans grouped project rows across every represented project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithGroupedCleanupThreads(),
    });

    try {
      const cleanupButton = page.getByTestId(`project-thread-cleanup-button-${PROJECT_ID}`);
      await expect.element(cleanupButton).toBeInTheDocument();
      await cleanupButton.click();

      await expect
        .element(
          page.getByText("This cleanup spans all 2 projects represented in this sidebar row."),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId(`cleanup-eligible-count-${PROJECT_ID}`))
        .toHaveTextContent("2");

      wsRequests.length = 0;
      await page.getByRole("button", { name: "Archive 2 threads" }).click();

      await vi.waitFor(
        () => {
          const archiveRequests = wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.archive",
          ) as Array<{ threadId?: ThreadId }>;
          expect(archiveRequests.map((request) => request.threadId).toSorted()).toEqual(
            [THREAD_ID, "thread-grouped-cleanup" as ThreadId].toSorted(),
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
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

  it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }),
        threads: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }).threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                branch: "feature/existing",
                worktreePath: "/repo/.forma/worktrees/existing",
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to a new draft thread.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new draft instead of reusing a promoting draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
        targetText: "promoting draft new thread test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const firstDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to the first draft thread.",
      );
      const firstDraftId = draftIdFromPath(firstDraftPath);
      const firstThreadId = draftThreadIdFor(firstDraftId);

      await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
      expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

      await newThreadButton.click();

      const secondDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
        "Route should change to a second draft thread instead of reusing the promoting draft.",
      );
      expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: createModelSelection("codex", "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: true },
        ]),
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

      // `toMatchObject` matches objects loosely (extras ignored) but compares
      // arrays strictly, so wrap `options` in `arrayContaining` to keep the
      // assertion focused on sticky `fastMode` carrying over without asserting
      // on exactly which other options are preserved.
      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
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
        claudeAgent: createModelSelection("claudeAgent", "claude-opus-4-6", [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
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
          claudeAgent: createModelSelection("claudeAgent", "claude-opus-4-6", [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ]),
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

  it("persists draft composer model changes selected from the model picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-grok-model-selection-test" as MessageId,
        targetText: "draft grok model selection test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              provider: "codex",
              models: [
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
            },
            {
              provider: "grok",
              displayName: "Grok",
              enabled: true,
              installed: true,
              version: "1.0.0",
              status: "warning",
              auth: { status: "unknown" },
              checkedAt: NOW_ISO,
              message: "Using fallback model list while provider status refreshes.",
              models: [
                {
                  slug: "grok-build",
                  name: "Grok Build",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
        };
      },
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

      const modelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find composer model picker.",
      );
      await modelPicker.click();

      const grokButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-model-picker-provider="grok"]'),
        "Unable to find Grok provider button.",
      );
      expect(grokButton.disabled).toBe(false);
      await grokButton.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")?.textContent ?? "").toContain(
          "Grok Build",
        );
      });
      await page.getByText("Grok Build").click();

      await vi.waitFor(() => {
        expect(composerDraftFor(newDraftId)).toMatchObject({
          modelSelectionByProvider: {
            grok: createModelSelection("grok", "grok-build"),
          },
          activeProvider: "grok",
        });
        expect(findComposerProviderModelPicker()?.textContent ?? "").toContain("Grok Build");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: createModelSelection("codex", "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: true },
        ]),
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

      // See the note on the sibling sticky-codex test: arrays match strictly
      // under `toMatchObject`, so use `arrayContaining` to keep the assertion
      // scoped to the sticky trait (`fastMode`) that must carry over.
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(
        draftId,
        createModelSelection("codex", "gpt-5.4", [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ]),
      );

      await newThreadButton.click();

      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: createModelSelection("codex", "gpt-5.4", [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: true },
          ]),
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
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
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

  it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
        targetText: "command palette add project enter",
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
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
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
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens add project browse mode from the sidebar add button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
        targetText: "sidebar add project trigger",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts add project browse mode from the configured base directory", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
        targetText: "sidebar add project custom base directory",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [{ name: "codething", fullPath: "~/Development/codething" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/Development/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows create-folder affordances for missing project paths", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
        targetText: "command palette create missing project",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Desktop/") {
            return {
              parentPath: "~/Desktop/",
              entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
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
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Desktop/fresh-project");

      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
                createWorkspaceRootIfMissing?: boolean;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Desktop/fresh-project",
            title: "fresh-project",
            createWorkspaceRootIfMissing: true,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show create affordances for an existing directory with a trailing slash", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
        targetText: "command palette existing trailing directory",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/codex/") {
            return {
              parentPath: "~/Development/codex/",
              entries: [{ name: "Codex.app", fullPath: "~/Development/codex/Codex.app" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
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
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/codex/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development/codex",
            title: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects an environment before browsing when multiple environments are available", async () => {
    const remoteBrowseMock = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "~/workspaces/") {
        return {
          parentPath: "~/workspaces/",
          entries: [{ name: "codething", fullPath: "~/workspaces/codething" }],
        };
      }

      return {
        parentPath: "~/",
        entries: [{ name: "workspaces", fullPath: "~/workspaces" }],
      };
    });
    const remoteDispatchMock = vi.fn(async () => ({
      sequence: fixture.snapshot.snapshotSequence + 1,
    }));

    __setEnvironmentApiOverrideForTests(
      REMOTE_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: remoteBrowseMock,
        dispatchCommand: remoteDispatchMock,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-multi-env" as MessageId,
        targetText: "command palette add project multi env",
      }),
    });

    try {
      await waitForServerConfigToApply();
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "Staging",
        httpBaseUrl: "https://staging.example.test",
        wsBaseUrl: "wss://staging.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });
      useSavedEnvironmentRuntimeStore.getState().patch(REMOTE_ENVIRONMENT_ID, {
        connectionState: "connected",
        authState: "authenticated",
        descriptor: {
          ...fixture.serverConfig.environment,
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "Staging",
        },
        serverConfig: {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Staging",
          },
          settings: {
            ...fixture.serverConfig.settings,
            addProjectBaseDirectory: "~/workspaces",
          },
        },
        connectedAt: NOW_ISO,
      });

      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await expect.element(palette.getByText("Environments", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("This device", { exact: true }).first())
        .toBeInTheDocument();
      await palette.getByText("Staging", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/workspaces/");

      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({ partialPath: "~/workspaces/" });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/workspaces/");
      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({ partialPath: "~/workspaces/" });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(palette.getByText("codething", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          expect(remoteDispatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "project.create",
              workspaceRoot: "~/workspaces",
              title: "workspaces",
            }),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a remote project.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks a local project from the native file manager", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
        targetText: "command palette add project file manager",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Applications/") {
            return {
              parentPath: "~/Applications/",
              entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Applications", fullPath: "~/Applications" }],
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
      await waitForServerConfigToApply();
      window.desktopBridge = {
        pickFolder,
        setTheme: vi.fn().mockResolvedValue(undefined),
      } as unknown as NonNullable<typeof window.desktopBridge>;

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await browseInput.fill("~/Applications/access");

      const fileManagerLabel = isMacPlatform(navigator.platform)
        ? "Open in Finder"
        : navigator.platform.toLowerCase().startsWith("win")
          ? "Open in Explorer"
          : "Open in Files";
      await palette.getByRole("button", { name: fileManagerLabel }).click();

      await vi.waitFor(
        () => {
          expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~/Applications" });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "/Users/julius/Projects/finder-picked",
            title: "finder-picked",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project from the native file manager.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
        targetText: "command palette add project mod enter",
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
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
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
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "ArrowDown" });

      const addButtonLabel = isMacPlatform(navigator.platform)
        ? "Add (\u2318 Enter)"
        : "Add (Ctrl Enter)";
      await vi.waitFor(
        () => {
          const legendEntries = getCommandPaletteLegendEntries();
          expect(legendEntries).toContain("Enter Select");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByRole("button", { name: addButtonLabel }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, {
        key: "Enter",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
      });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
      );
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

  it("opens the in-app editor from an assistant markdown file link and preserves turn context", async () => {
    mockLocalWorkspaceEditorEnvironmentApi();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink(),
    });

    try {
      await page.getByRole("link", { name: "linked.ts · L4:C2" }).click();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffTurnId: "turn-linked-editor",
          diffFilePath: "src/linked.ts",
          diffView: "editor",
          editorFilePath: "src/linked.ts",
          editorLine: 4,
          editorColumn: 2,
          editorBackToView: "diff",
        });
      });
      await expect.element(page.getByLabelText("Close file", { exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("returns to the selected diff after closing an editor session opened from diff", async () => {
    mockLocalWorkspaceEditorEnvironmentApi();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink(),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?diff=1&diffTurnId=turn-linked-editor&diffFilePath=src%2Flinked.ts&diffView=editor&editorFilePath=src%2Flinked.ts&editorLine=4&editorColumn=2&editorBackToView=diff`,
    });

    try {
      await expect.element(page.getByLabelText("Close file", { exact: true })).toBeVisible();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffTurnId: "turn-linked-editor",
          diffFilePath: "src/linked.ts",
          diffView: "editor",
          editorFilePath: "src/linked.ts",
          editorBackToView: "diff",
        });
      });

      await page.getByLabelText("Close file", { exact: true }).click();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffTurnId: "turn-linked-editor",
          diffFilePath: "src/linked.ts",
        });
        expect(mounted.router.state.location.search.diffView).toBeUndefined();
        expect(mounted.router.state.location.search.editorFilePath).toBeUndefined();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("returns to diff after exiting a turn-linked editor session opened directly from chat", async () => {
    mockLocalWorkspaceEditorEnvironmentApi();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink(),
    });

    try {
      await page.getByRole("link", { name: "linked.ts · L4:C2" }).click();
      await expect.element(page.getByLabelText("Close file", { exact: true })).toBeVisible();

      await page.getByLabelText("Close file", { exact: true }).click();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffTurnId: "turn-linked-editor",
          diffFilePath: "src/linked.ts",
        });
        expect(mounted.router.state.location.search.diffView).toBeUndefined();
        expect(mounted.router.state.location.search.editorFilePath).toBeUndefined();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens and closes a standalone editor session from a chat file link", async () => {
    mockLocalWorkspaceEditorEnvironmentApi();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink({ turnLinked: false }),
    });

    try {
      await page.getByRole("link", { name: "linked.ts · L4:C2" }).click();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffView: "editor",
          editorFilePath: "src/linked.ts",
          editorLine: 4,
          editorColumn: 2,
        });
        expect(mounted.router.state.location.search.diffTurnId).toBeUndefined();
        expect(mounted.router.state.location.search.editorBackToView).toBeUndefined();
      });
      await expect.element(page.getByLabelText("Close file", { exact: true })).toBeVisible();

      await page.getByLabelText("Close file", { exact: true }).click();

      await vi.waitFor(() => {
        expect(mounted.router.state.location.search.diff).toBeUndefined();
        expect(mounted.router.state.location.search.diffView).toBeUndefined();
        expect(mounted.router.state.location.search.editorFilePath).toBeUndefined();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to opening the IDE when a chat file link is outside the active workspace", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink({
        turnLinked: false,
        workspaceFilePath: "/tmp/outside-linked.ts",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await page.getByRole("link", { name: "linked.ts · L4:C2" }).click();

      await vi.waitFor(() => {
        expect(
          wsRequests.some(
            (request) =>
              request._tag === WS_METHODS.shellOpenInEditor &&
              request.cwd === "/tmp/outside-linked.ts:4:2" &&
              request.editor === "vscode",
          ),
        ).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores the routed editor view from the URL on initial load", async () => {
    mockLocalWorkspaceEditorEnvironmentApi();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink({ turnLinked: false }),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?diff=1&diffView=editor&editorFilePath=src%2Flinked.ts&editorLine=4&editorColumn=2`,
    });

    try {
      await expect.element(page.getByLabelText("Close file", { exact: true })).toBeVisible();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toMatchObject({
          diff: "1",
          diffView: "editor",
          editorFilePath: "src/linked.ts",
          editorLine: 4,
          editorColumn: 2,
        });
      });
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
          "# Imaginary Long-Range Plan: Forma Adaptive Orchestration and Safe-Delay Execution Initiative",
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
          "# Imaginary Long-Range Plan: Forma Adaptive Orchestration and Safe-Delay Execution Initiative",
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

  it("opens the model picker when selecting /model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-command-target" as MessageId,
        targetText: "model command thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/mod");

      const menuItem = await waitForComposerMenuItem("slash:model");
      await menuItem.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
      targetText: "model picker shortcut thread",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID
            ? Object.assign({}, project, {
                defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
              })
            : project,
        ),
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: { provider: "codex", model: "gpt-5.4" },
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              provider: "codex",
              models: [
                {
                  slug: "gpt-5.1-codex-max",
                  name: "GPT-5.1 Codex Max",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
              ],
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();

      const initialPath = mounted.router.state.location.pathname;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
          ).some((element) => element.textContent?.trim() === jumpLabel),
        ).toBe(true);
      });
      expect(mounted.router.state.location.pathname).toBe(initialPath);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      releaseModShortcut("Control");
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

  it("opens and closes the shared terminal drawer from the workspace header toggle", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-toggle" as MessageId,
        targetText: "terminal toggle thread",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByLabelText("Toggle terminal drawer").click();

      await vi.waitFor(
        () => {
          expect(document.querySelector(".thread-terminal-drawer")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByLabelText("Toggle terminal drawer").click();

      await vi.waitFor(
        () => {
          expect(document.querySelector(".thread-terminal-drawer")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens and closes the shared preview drawer from the workspace header toggle", async () => {
    window.addEventListener("unhandledrejection", swallowPreviewDrawerUnhandledRejection);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-preview-toggle" as MessageId,
        targetText: "preview toggle thread",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByLabelText("Toggle preview drawer").click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Search for a component or open preview from a file.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByLabelText("Toggle preview drawer").click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain(
            "Search for a component or open preview from a file.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      window.removeEventListener("unhandledrejection", swallowPreviewDrawerUnhandledRejection);
      await mounted.cleanup();
    }
  });

  it("updates the preview drawer project scope when the active project changes", async () => {
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
      __setEnvironmentApiOverrideForTests(
        LOCAL_ENVIRONMENT_ID,
        createMockEnvironmentApi({
          browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
          dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        }),
      );

      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();

      await page.getByLabelText("Toggle files panel").click();
      await page.getByLabelText("Toggle preview drawer").click();

      await vi.waitFor(
        () => {
          expect(usePreviewWorkspaceStore.getState().activeProjectRef).toEqual(
            scopeProjectRef(LOCAL_ENVIRONMENT_ID, PROJECT_ID),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await palette.getByText("Docs Portal", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the selected project's thread.",
      );

      await vi.waitFor(
        () => {
          expect(usePreviewWorkspaceStore.getState().activeProjectRef).toEqual(
            scopeProjectRef(LOCAL_ENVIRONMENT_ID, SECOND_PROJECT_ID),
          );
          expect(document.body.textContent).toContain("Docs Portal");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the chat header actions menu and copies thread markdown", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-actions-menu" as MessageId,
        targetText: "header actions menu thread",
      }),
    });

    try {
      await page.getByLabelText("More actions").click();
      await expect(page.getByRole("menuitem", { name: "Add action" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Commit" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Push" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Create PR" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Copy thread as Markdown" }).click();

      await vi.waitFor(
        () => {
          expect(writeText).toHaveBeenCalledTimes(1);
          const copiedMarkdown = writeText.mock.calls[0]?.[0] ?? "";
          expect(copiedMarkdown).toContain("## Metadata");
          expect(copiedMarkdown).toContain("## Messages");
          expect(document.body.textContent).toContain("Thread markdown copied");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the add action dialog open after selecting it from the header menu", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-add-action-menu" as MessageId,
        targetText: "add action menu thread",
      }),
    });

    try {
      await page.getByLabelText("More actions").click();
      await page.getByRole("menuitem", { name: "Add action" }).click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Add Action");
          expect(document.body.textContent).toContain(
            "Actions are project-scoped commands you can run from the top bar or keybindings.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("launches the component preview after preview generation completes", async () => {
    let previewGenerated = false;

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        preview: {
          inspectProject: vi.fn(async ({ projectId }) => ({
            projectId,
            provider: "componentHarness" as const,
            status: "ready" as const,
            framework: "react-vite" as const,
            bootstrapFilesPresent: true,
            summary: "Component preview is ready.",
          })),
          resolveTarget: vi.fn(async ({ relativePath }) =>
            previewGenerated
              ? {
                  status: "resolved" as const,
                  relativePath,
                  previewFileRelativePath: "src/Button.preview.tsx",
                  initialScenarioId: "default",
                  iframePath: "/preview.html?component=src%2FButton.tsx",
                  directIframeUrl: "http://127.0.0.1:4173/preview.html?component=src%2FButton.tsx",
                  scenarioChoices: [
                    {
                      id: "default",
                      name: "Default",
                    },
                  ],
                }
              : {
                  status: "needsGeneration" as const,
                  relativePath,
                  workspaceRootRelativePath: "",
                  threadId: THREAD_ID,
                  previewFileRelativePath: "src/Button.preview.tsx",
                  reason: "A preview file has not been generated for this component yet.",
                },
          ),
          preparePreviewGenerationTurn: vi.fn(async () => ({
            workspaceRootRelativePath: "",
            threadId: THREAD_ID,
            turnPrompt: "Create a preview file for src/Button.tsx.",
            previewFileRelativePath: "src/Button.preview.tsx",
          })),
        },
      }),
    );

    useBottomDrawerUiStore.setState({
      visibleMode: "preview",
      previousVisibleMode: null,
      sharedHeight: 320,
    });
    usePreviewWorkspaceStore.setState({
      activeProjectRef: scopeProjectRef(LOCAL_ENVIRONMENT_ID, PROJECT_ID),
      projectStateByKey: {
        [`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`]: {
          currentRelativePath: "src/Button.tsx",
          currentPreviewFileRelativePath: null,
          runtimeSnapshot: null,
          sessionsByPreviewFilePath: {},
          runtimeState: null,
          resolution: null,
          inspection: null,
          accessToken: null,
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-preview-story-create" as MessageId,
        targetText: "preview story create thread",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Generating component preview");
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByRole("button", { name: "Regenerate preview" }).click();

      previewGenerated = true;
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: {
                  turnId: "turn-preview-story-created" as TurnId,
                  state: "completed",
                  requestedAt: isoAt(80),
                  startedAt: isoAt(81),
                  completedAt: isoAt(82),
                  assistantMessageId: null,
                },
                session: {
                  ...thread.session!,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(82),
                },
                updatedAt: isoAt(82),
              }
            : thread,
        ),
        updatedAt: isoAt(82),
      };
      emitThreadSnapshot();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("Generating component preview");
          const iframe = document.querySelector<HTMLIFrameElement>("iframe");
          expect(iframe).not.toBeNull();
          expect(iframe?.src).toContain("src%2FButton.tsx");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles diff mode from the shared workspace header and restores files mode", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-diff-toggle" as MessageId,
        targetText: "diff toggle thread",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByLabelText("Toggle diff view").click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search.diff).toBe("1");
          expect(mounted.router.state.location.search.diffView).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByLabelText("Toggle diff view").click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "files",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders a scrollable diff surface from the shared workspace header", async () => {
    const largeDiff = [
      "diff --git a/src/linked.ts b/src/linked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/linked.ts",
      "+++ b/src/linked.ts",
      "@@ -1,80 +1,80 @@",
      ...Array.from({ length: 80 }, (_, index) => [
        `-export const before${index} = ${index};`,
        `+export const after${index} = ${index};`,
      ]).flat(),
    ].join("\n");

    mockLocalWorkspaceEditorEnvironmentApi({ diff: largeDiff });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithAssistantFileLink(),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByLabelText("Toggle diff view").click();

      await vi.waitFor(
        () => {
          const scroller = document.querySelector<HTMLElement>(".diff-render-viewport");
          expect(scroller).not.toBeNull();
          expect(scroller?.clientHeight ?? 0).toBeGreaterThan(0);
          expect(scroller?.scrollHeight ?? 0).toBeGreaterThan(scroller?.clientHeight ?? 0);
        },
        { timeout: 8_000, interval: 16 },
      );

      const previewButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Preview",
      );
      expect(previewButton).toBeUndefined();

      const scroller = document.querySelector<HTMLElement>(".diff-render-viewport");
      expect(scroller).not.toBeNull();
      scroller!.scrollTop = 320;
      scroller!.dispatchEvent(new Event("scroll"));
      expect(scroller!.scrollTop).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the files panel from the header and renders the workspace tree", async () => {
    const listEntries = vi.fn(
      async ({
        relativePath,
      }: {
        readonly cwd: string;
        readonly relativePath?: string | null | undefined;
      }) => {
        if (relativePath === "src") {
          return {
            entries: [
              {
                path: "src/linked.ts",
                kind: "file" as const,
                parentPath: "src",
              },
            ],
          };
        }

        return {
          entries: [
            {
              path: "src",
              kind: "directory" as const,
              parentPath: undefined,
            },
            {
              path: "README.md",
              kind: "file" as const,
              parentPath: undefined,
            },
          ],
        };
      },
    );

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        listEntries,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-files-toggle" as MessageId,
        targetText: "files toggle thread",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "files",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect.element(page.getByText("Select a file to open it.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "src" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "README.md" })).toBeVisible();
      await vi.waitFor(
        () => {
          expect(listEntries).toHaveBeenCalledWith({
            cwd: "/repo/project",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a workspace file from the files tree in the editor", async () => {
    const listEntries = vi.fn(
      async ({
        relativePath,
      }: {
        readonly cwd: string;
        readonly relativePath?: string | null | undefined;
      }) => {
        if (relativePath === "src") {
          return {
            entries: [
              {
                path: "src/linked.ts",
                kind: "file" as const,
                parentPath: "src",
              },
            ],
          };
        }

        return {
          entries: [
            {
              path: "src",
              kind: "directory" as const,
              parentPath: undefined,
            },
          ],
        };
      },
    );
    const readFile = vi.fn(async () => ({
      relativePath: "src/linked.ts",
      contents: "export const linked = true;\n",
      version: FILE_VERSION_A,
    }));

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        listEntries,
        readFile,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-files-open-editor" as MessageId,
        targetText: "open files editor",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByRole("button", { name: "src" }).click();

      await vi.waitFor(
        () => {
          expect(listEntries).toHaveBeenCalledWith({
            cwd: "/repo/project",
            relativePath: "src",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByRole("button", { name: "linked.ts" }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "editor",
            editorFilePath: "src/linked.ts",
            editorBackToView: "files",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect.element(page.getByLabelText("Close files panel")).toBeVisible();

      await vi.waitFor(
        () => {
          expect(readFile).toHaveBeenCalledWith({
            cwd: "/repo/project",
            relativePath: "src/linked.ts",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const popupHeights = [
            ...document.querySelectorAll<HTMLElement>("[data-slot='sheet-popup']"),
          ]
            .map((popup) => popup.getBoundingClientRect().height)
            .toSorted((left, right) => right - left);
          expect(popupHeights.length).toBeGreaterThan(0);
          expect(popupHeights[0] ?? 0).toBeGreaterThan(400);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches the editor contents when selecting a different workspace file", async () => {
    const listEntries = vi.fn(
      async ({
        relativePath,
      }: {
        readonly cwd: string;
        readonly relativePath?: string | null | undefined;
      }) => {
        if (relativePath === "src") {
          return {
            entries: [
              {
                path: "src/linked.ts",
                kind: "file" as const,
                parentPath: "src",
              },
              {
                path: "src/other.ts",
                kind: "file" as const,
                parentPath: "src",
              },
            ],
          };
        }

        return {
          entries: [
            {
              path: "src",
              kind: "directory" as const,
              parentPath: undefined,
            },
          ],
        };
      },
    );
    const readFile = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
      relativePath,
      contents:
        relativePath === "src/other.ts"
          ? "export const other = true;\n"
          : "export const linked = true;\n",
      version: relativePath === "src/other.ts" ? FILE_VERSION_B : FILE_VERSION_A,
    }));

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        listEntries,
        readFile,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-files-switch-editor" as MessageId,
        targetText: "switch files editor",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByRole("button", { name: "src" }).click();
      await page.getByRole("button", { name: "linked.ts" }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "editor",
            editorFilePath: "src/linked.ts",
            editorBackToView: "files",
          });
          expect(readFile).toHaveBeenCalledWith({
            cwd: "/repo/project",
            relativePath: "src/linked.ts",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByRole("button", { name: "other.ts" }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "editor",
            editorFilePath: "src/linked.ts",
            editorBackToView: "files",
          });
          expect(readFile).toHaveBeenCalledWith({
            cwd: "/repo/project",
            relativePath: "src/other.ts",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches workspace files from the files panel sidebar", async () => {
    const listEntries = vi.fn(async () => ({
      entries: [
        {
          path: "src",
          kind: "directory" as const,
          parentPath: undefined,
        },
      ],
    }));
    const searchEntries = vi.fn(async ({ query }: { readonly query: string }) => ({
      entries:
        query === "linked"
          ? [
              {
                path: "src/linked.ts",
                kind: "file" as const,
                parentPath: "src",
              },
            ]
          : [],
      truncated: false,
    }));
    const readFile = vi.fn(async () => ({
      relativePath: "src/linked.ts",
      contents: "export const linked = true;\n",
      version: FILE_VERSION_A,
    }));

    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: vi.fn(async () => ({ parentPath: "~/", entries: [] })),
        dispatchCommand: vi.fn(async () => ({ sequence: fixture.snapshot.snapshotSequence + 1 })),
        listEntries,
        readFile,
        searchEntries,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-files-search-editor" as MessageId,
        targetText: "search files editor",
      }),
    });

    try {
      await page.getByLabelText("Toggle files panel").click();
      await page.getByPlaceholder("Search files...").fill("linked");

      await vi.waitFor(
        () => {
          expect(searchEntries).toHaveBeenCalledWith({
            cwd: "/repo/project",
            query: "linked",
            limit: 80,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByRole("button", { name: /linked\.ts/ }).click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "editor",
            editorFilePath: "src/linked.ts",
            editorBackToView: "files",
          });
          expect(readFile).toHaveBeenCalledWith({
            cwd: "/repo/project",
            relativePath: "src/linked.ts",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables diff on draft threads while keeping files available", async () => {
    setDraftThreadWithoutWorktree();
    const draftId = DraftId.make(THREAD_KEY);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      await expect.element(page.getByLabelText("Toggle files panel")).toBeEnabled();
      expect(document.querySelector('[aria-label="Toggle diff panel"]')).toBeNull();

      await page.getByLabelText("Toggle files panel").click();

      await vi.waitFor(
        () => {
          expect(decodeURIComponent(mounted.router.state.location.pathname)).toBe(
            `/draft/${draftId}`,
          );
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffView: "files",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[aria-label="Toggle diff view"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
