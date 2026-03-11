import "../index.css";

import type { NativeApi, OrchestrationReadModel, ServerConfig } from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";

const NOW_ISO = "2026-03-11T00:00:00.000Z";
const DESKTOP_VIEWPORT = {
  width: 1280,
  height: 900,
};

const EMPTY_SNAPSHOT: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: NOW_ISO,
};

const SERVER_CONFIG: ServerConfig = {
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

function createNativeApiStub(): NativeApi {
  return {
    dialogs: {
      pickFolder: async () => null,
      confirm: async () => false,
    },
    terminal: {
      open: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      write: async () => undefined,
      resize: async () => undefined,
      clear: async () => undefined,
      restart: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      close: async () => undefined,
      onEvent: () => () => undefined,
    },
    projects: {
      searchEntries: async () => ({ entries: [], truncated: false }),
      writeFile: async () => ({ relativePath: "notes.txt" }),
    },
    shell: {
      openInEditor: async () => undefined,
      openExternal: async () => undefined,
    },
    git: {
      listBranches: async () => ({
        isRepo: false,
        hasOriginRemote: false,
        branches: [],
      }),
      createWorktree: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      removeWorktree: async () => undefined,
      createBranch: async () => undefined,
      checkout: async () => undefined,
      init: async () => undefined,
      resolvePullRequest: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      preparePullRequestThread: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      pull: async () => ({
        status: "skipped_up_to_date",
        branch: "main",
        upstreamBranch: null,
      }),
      status: async () => ({
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      runStackedAction: async () => ({
        action: "commit",
        branch: {
          status: "skipped_not_requested",
        },
        commit: {
          status: "skipped_no_changes",
        },
        push: {
          status: "skipped_not_requested",
        },
        pr: {
          status: "skipped_not_requested",
        },
      }),
    },
    contextMenu: {
      show: async () => null,
    },
    server: {
      getConfig: async () => SERVER_CONFIG,
      upsertKeybinding: async () => ({
        keybindings: [],
        issues: [],
      }),
    },
    orchestration: {
      getSnapshot: async () => EMPTY_SNAPSHOT,
      dispatchCommand: async () => ({ sequence: 1 }),
      getTurnDiff: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      getFullThreadDiff: async () => {
        throw new Error("Not implemented in Sidebar.browser test");
      },
      replayEvents: async () => [],
      onDomainEvent: () => () => undefined,
    },
  };
}

async function mountApp(): Promise<{ cleanup: () => Promise<void> }> {
  await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Sidebar startup state", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    window.nativeApi = createNativeApiStub();
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

  it("shows a loading spinner before hydration, then falls back to the empty state", async () => {
    const mounted = await mountApp();

    try {
      await expect.element(page.getByText("Loading projects and threads")).toBeInTheDocument();
      await expect
        .element(page.getByText("Restoring your workspace from the server."))
        .toBeInTheDocument();
      await expect.element(page.getByText("No projects yet")).not.toBeInTheDocument();

      useStore.setState({
        projects: [],
        threads: [],
        threadsHydrated: true,
      });

      await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
      await expect.element(page.getByText("Loading projects and threads")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
