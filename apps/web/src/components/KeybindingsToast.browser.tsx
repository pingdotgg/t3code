import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig, getServerConfigUpdatedNotification } from "../rpc/serverState";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { getRouter } from "../router";
import { useStore } from "../store";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness } from "../../test/wsRpcHarness";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const THREAD_ID = "thread-kb-toast-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: LOCAL_ENVIRONMENT_ID,
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
      enableAssistantStreaming: false,
      defaultThreadEnvMode: "local" as const,
      textGenerationModelSelection: { provider: "codex" as const, model: "gpt-5.4-mini" },
      providers: {
        codex: { enabled: true, binaryPath: "", homePath: "", customModels: [] },
        claudeAgent: { enabled: true, binaryPath: "", customModels: [], launchArgs: "" },
        cursor: { enabled: true, binaryPath: "", apiEndpoint: "", customModels: [] },
        opencode: {
          enabled: true,
          binaryPath: "",
          serverUrl: "",
          serverPassword: "",
          customModels: [],
        },
      },
    },
  };
}

function createMinimalSnapshot(): OrchestrationReadModel {
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
        title: "Test thread",
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
        messages: [
          {
            id: "msg-1" as MessageId,
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
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
    threads: snapshot.threads.map((thread) => ({
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
    })),
    updatedAt: snapshot.updatedAt,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createMinimalSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: LOCAL_ENVIRONMENT_ID,
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

function resolveWsRpc(tag: string): unknown {
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      nextCursor: null,
      totalCount: 1,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
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
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

function sendServerConfigUpdatedPush(issues: ServerConfig["issues"]) {
  rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
    version: 1,
    type: "keybindingsUpdated",
    payload: { issues },
  });
}

function queryToastTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="toast-title"]')).map(
    (el) => el.textContent ?? "",
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
    { timeout: 8_000, interval: 16 },
  );
  return element!;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
    "App should render composer editor",
  );
}

async function waitForToastViewport(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-slot="toast-viewport"]'),
    "App should render the toast viewport before server config updates are pushed",
  );
}

async function waitForWsConnection(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getWsConnectionStatus().phase).toBe("connected");
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForToast(title: string, count = 1): Promise<void> {
  await vi.waitFor(
    () => {
      const matches = queryToastTitles().filter((t) => t === title);
      expect(matches.length, `Expected ${count} "${title}" toast(s)`).toBeGreaterThanOrEqual(count);
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function waitForNoToast(title: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryToastTitles().filter((t) => t === title)).toHaveLength(0);
    },
    { timeout: 10_000, interval: 50 },
  );
}

async function waitForNoToasts(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryToastTitles()).toHaveLength(0);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInitialWsSubscriptions(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerConfig),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForServerConfigSnapshot(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForServerConfigStreamReady(): Promise<void> {
  const previousNotificationId = getServerConfigUpdatedNotification()?.id ?? 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: fixture.serverConfig.settings },
    });

    try {
      await vi.waitFor(
        () => {
          const notification = getServerConfigUpdatedNotification();
          expect(notification?.id).toBeGreaterThan(previousNotificationId);
          expect(notification?.source).toBe("settingsUpdated");
        },
        { timeout: 200, interval: 16 },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error("Timed out waiting for the server config stream to deliver updates.");
}

async function mountApp(): Promise<{ cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`] }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    { container: host },
  );
  await waitForComposerEditor();
  await waitForToastViewport();
  await waitForInitialWsSubscriptions();
  await waitForWsConnection();
  await waitForServerConfigSnapshot();
  await waitForServerConfigStreamReady();
  await waitForNoToasts();

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Keybindings update toast", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: (request) => resolveWsRpc(request._tag),
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
        if (
          request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
          request.threadId === THREAD_ID
        ) {
          return [
            {
              kind: "snapshot",
              snapshot: {
                snapshotSequence: fixture.snapshot.snapshotSequence,
                thread: fixture.snapshot.threads[0],
              },
            },
          ];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a toast for each consecutive keybinding update with no issues", async () => {
    const mounted = await mountApp();

    try {
      sendServerConfigUpdatedPush([]);
      await waitForToast("Keybindings updated", 1);

      // Each server push represents a distinct file change, so it should produce its own toast.
      sendServerConfigUpdatedPush([]);
      await waitForToast("Keybindings updated", 2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a warning toast when keybinding config has issues", async () => {
    const mounted = await mountApp();

    try {
      sendServerConfigUpdatedPush([
        { kind: "keybindings.malformed-config", message: "Expected JSON array" },
      ]);
      await waitForToast("Invalid keybindings configuration");
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show a toast from the replayed cached value on subscribe", async () => {
    const mounted = await mountApp();

    try {
      sendServerConfigUpdatedPush([]);
      await waitForToast("Keybindings updated");
      await waitForNoToast("Keybindings updated");

      // Remount the app — onServerConfigUpdated replays the cached value
      // synchronously on subscribe. This should NOT produce a toast.
      await mounted.cleanup();
      const remounted = await mountApp();

      // Give it a moment to process the replayed value
      await new Promise((resolve) => setTimeout(resolve, 500));

      const titles = queryToastTitles();
      expect(
        titles.filter((t) => t === "Keybindings updated").length,
        "Replayed cached value should not produce a toast",
      ).toBe(0);

      await remounted.cleanup();
    } catch (error) {
      await mounted.cleanup().catch(() => {});
      throw error;
    }
  });
});
