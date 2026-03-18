import "../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";

vi.mock("../components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const THREAD_ID = "thread-bootstrap-recovery-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const SNAPSHOT_ERROR_MESSAGE = "Projection snapshot failed: malformed persisted state.";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
let pushSequence = 1;
let snapshotResponses: Array<"error" | "success"> = [];

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
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
        defaultModel: "gpt-5",
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
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
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

function buildFixture(): TestFixture {
  return {
    snapshot: createMinimalSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
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
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    pushSequence = 1;
    client.send(
      JSON.stringify({
        type: "push",
        sequence: pushSequence++,
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      let request: { id: string; body: { _tag: string; [key: string]: unknown } };
      try {
        request = JSON.parse(rawData);
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") return;

      if (method === ORCHESTRATION_WS_METHODS.getSnapshot) {
        const responseMode = snapshotResponses.shift() ?? "success";
        client.send(
          JSON.stringify(
            responseMode === "error"
              ? {
                  id: request.id,
                  error: {
                    message: SNAPSHOT_ERROR_MESSAGE,
                  },
                }
              : {
                  id: request.id,
                  result: fixture.snapshot,
                },
          ),
        );
        return;
      }

      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(method),
        }),
      );
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

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

async function waitForNoComposerEditor(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(document.querySelector('[data-testid="composer-editor"]')).toBeNull();
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function waitForRecoveryView(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-testid="initial-snapshot-recovery"]'),
    "Expected initial snapshot recovery view",
  );
}

async function waitForButton(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(label),
      ) ?? null,
    `Expected button "${label}"`,
  );
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

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Initial snapshot recovery", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    pushSequence = 1;
    snapshotResponses = [];
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a blocking recovery view when the initial snapshot fails", async () => {
    snapshotResponses = ["error"];
    const mounted = await mountApp();

    try {
      const recoveryView = await waitForRecoveryView();
      expect(recoveryView.textContent).toContain("Couldn't load app state.");
      expect(recoveryView.textContent).toContain("T3CODE_STATE_DIR");
      expect(recoveryView.textContent).toContain("CODEX_HOME");
      expect(recoveryView.textContent).toContain(SNAPSHOT_ERROR_MESSAGE);
      await waitForButton("Retry snapshot");
      await waitForNoComposerEditor();
    } finally {
      await mounted.cleanup();
    }
  });

  it("recovers after retrying a failed initial snapshot", async () => {
    snapshotResponses = ["error", "success"];
    const mounted = await mountApp();

    try {
      await waitForRecoveryView();
      const retryButton = await waitForButton("Retry snapshot");
      retryButton.click();

      await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-testid="initial-snapshot-recovery"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
