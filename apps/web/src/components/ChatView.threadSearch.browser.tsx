import "../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  DEFAULT_SERVER_SETTINGS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import { isMacPlatform } from "../lib/utils";

const THREAD_ID = "thread-search-browser" as ThreadId;
const SECOND_THREAD_ID = "thread-search-browser-second" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
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
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
        models: [],
      },
    ],
    availableEditors: [],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

function createSearchSnapshot(): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 24; index += 1) {
    const userId = `user-${index}` as MessageId;
    const assistantId = `assistant-${index}` as MessageId;

    const userText =
      index === 0
        ? "virtualized alpha marker near the top"
        : index === 8
          ? "second alpha marker closer to the middle"
          : `filler user message ${index}`;

    messages.push({
      id: userId,
      role: "user",
      text: userText,
      turnId: null,
      streaming: false,
      createdAt: isoAt(messages.length * 3),
      updatedAt: isoAt(messages.length * 3 + 1),
    });
    messages.push({
      id: assistantId,
      role: "assistant",
      text: `assistant filler ${index}`,
      turnId: null,
      streaming: false,
      createdAt: isoAt(messages.length * 3),
      updatedAt: isoAt(messages.length * 3 + 1),
    });
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
        title: "Thread search test thread",
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
        queuedFollowUps: [],
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
      {
        id: SECOND_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Second thread",
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
            id: "second-thread-message-1" as MessageId,
            role: "assistant",
            text: "This second thread should not inherit any stale search state.",
            turnId: null,
            streaming: false,
            createdAt: isoAt(500),
            updatedAt: isoAt(501),
          },
        ],
        queuedFollowUps: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: SECOND_THREAD_ID,
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
    snapshot: createSearchSnapshot(),
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
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
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
    client.send(
      JSON.stringify({
        type: "push",
        sequence: 1,
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
    "ChatView should render the composer editor",
  );
}

async function waitForSearchInput(): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector<HTMLInputElement>('[data-testid="thread-search-input"]'),
    "Thread search input should be visible",
  );
}

function dispatchThreadSearchShortcut() {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "f",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchSearchInputKey(key: string, options: { shiftKey?: boolean } = {}) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="thread-search-input"]');
  if (!input) {
    throw new Error("Thread search input is not mounted");
  }
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: options.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function mountApp(): Promise<{
  cleanup: () => Promise<void>;
  router: ReturnType<typeof getRouter>;
}> {
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
  await waitForComposerEditor();

  return {
    router,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function waitForActiveMessageRow(messageId: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>(
        `[data-message-id="${messageId}"][data-search-match-state="active"]`,
      ),
    `Message row ${messageId} should be the active search result`,
  );
}

async function waitForActiveSearchHighlight(messageId: string, text: string): Promise<HTMLElement> {
  return waitForElement(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"][data-search-match-state="active"]`,
    );
    if (!row) {
      return null;
    }
    return (
      Array.from(
        row.querySelectorAll<HTMLElement>('mark[data-thread-search-highlight="active"]'),
      ).find((element) => element.textContent?.toLowerCase() === text.toLowerCase()) ?? null
    );
  }, `Message row ${messageId} should highlight "${text}" inline`);
}

async function waitForAnyTimelineRow(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>("[data-timeline-row-id]"),
    "At least one timeline row should be rendered",
  );
}

describe("ChatView thread search", () => {
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
    fixture = buildFixture();
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
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

  it("opens with Cmd/Ctrl+F and restores composer focus when dismissed", async () => {
    const mounted = await mountApp();

    try {
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      dispatchThreadSearchShortcut();

      const searchInput = await waitForSearchInput();
      await page.getByTestId("thread-search-input").fill("alpha marker");
      await waitForActiveSearchHighlight("user-0", "alpha marker");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(searchInput);
      });

      dispatchSearchInputKey("Escape");

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-search-input"]')).toBeNull();
        expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor");
        expect(document.querySelector('[data-thread-search-highlight="active"]')).toBeNull();
        expect(document.querySelector('[data-search-match-state="active"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the original focus restore target when Cmd/Ctrl+F is pressed again inside search", async () => {
    const mounted = await mountApp();

    try {
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      dispatchThreadSearchShortcut();
      await waitForSearchInput();

      dispatchThreadSearchShortcut();
      dispatchSearchInputKey("Escape");

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-search-input"]')).toBeNull();
        expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not shift the thread layout when opened", async () => {
    const mounted = await mountApp();

    try {
      await waitForAnyTimelineRow();
      const messagesScrollContainer = document.querySelector<HTMLElement>(".overscroll-y-contain");
      expect(messagesScrollContainer).toBeTruthy();
      const beforeTop = messagesScrollContainer!.getBoundingClientRect().top;

      dispatchThreadSearchShortcut();
      await waitForSearchInput();

      await vi.waitFor(() => {
        const afterTop = document
          .querySelector<HTMLElement>(".overscroll-y-contain")
          ?.getBoundingClientRect().top;
        expect(afterTop).toBeDefined();
        expect(Math.abs((afterTop ?? 0) - beforeTop)).toBeLessThan(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the no-match state and disables result navigation", async () => {
    const mounted = await mountApp();

    try {
      dispatchThreadSearchShortcut();
      const searchInput = await waitForSearchInput();
      searchInput.focus();
      await page.getByTestId("thread-search-input").fill("does-not-exist");

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-search-count"]')?.textContent).toBe(
          "No matches",
        );
      });
      await expect.element(page.getByLabelText("Previous search result")).toBeDisabled();
      await expect.element(page.getByLabelText("Next search result")).toBeDisabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("cycles between matches with Enter, Shift+Enter, and the next button", async () => {
    const mounted = await mountApp();

    try {
      dispatchThreadSearchShortcut();
      await page.getByTestId("thread-search-input").fill("alpha marker");

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-search-count"]')?.textContent).toBe(
          "1 / 2",
        );
      });
      await waitForActiveMessageRow("user-0");
      await waitForActiveSearchHighlight("user-0", "alpha marker");

      dispatchSearchInputKey("Enter");
      await waitForActiveMessageRow("user-8");
      await waitForActiveSearchHighlight("user-8", "alpha marker");

      dispatchSearchInputKey("Enter", { shiftKey: true });
      await waitForActiveMessageRow("user-0");
      await waitForActiveSearchHighlight("user-0", "alpha marker");

      await page.getByLabelText("Next search result").click();
      await waitForActiveMessageRow("user-8");
      await waitForActiveSearchHighlight("user-8", "alpha marker");
    } finally {
      await mounted.cleanup();
    }
  });

  it("pulls an older virtualized match into the DOM when selected", async () => {
    const mounted = await mountApp();

    try {
      expect(document.body.textContent ?? "").not.toContain(
        "virtualized alpha marker near the top",
      );

      dispatchThreadSearchShortcut();
      await page.getByTestId("thread-search-input").fill("virtualized alpha marker near the top");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("virtualized alpha marker near the top");
      });
      await waitForActiveMessageRow("user-0");
      await waitForActiveSearchHighlight("user-0", "virtualized alpha marker near the top");
    } finally {
      await mounted.cleanup();
    }
  });

  it("resets the search UI and query when navigating to another thread", async () => {
    const mounted = await mountApp();

    try {
      dispatchThreadSearchShortcut();
      await page.getByTestId("thread-search-input").fill("alpha marker");
      await waitForActiveSearchHighlight("user-0", "alpha marker");

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: SECOND_THREAD_ID },
      });

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-message-id="second-thread-message-1"]'),
        "Second thread content should be rendered after navigation",
      );

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="thread-search-input"]')).toBeNull();
        expect(document.querySelector('[data-search-match-state="active"]')).toBeNull();
        expect(document.querySelector('[data-thread-search-highlight="active"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
