// @vitest-environment jsdom

import { ProviderInstanceId, RunId, type ScopedThreadRef } from "@t3tools/contracts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  threads: new Map<string, ThreadFixtureOverrides>(),
  detail: vi.fn(),
  visits: {} as Record<string, string>,
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { threadCycleOrder: string }) => unknown) =>
    select({ threadCycleOrder: "recent" }),
}));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../modelPickerVisibility", () => ({ isModelPickerOpen: () => false }));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef) =>
    makeThreadFixture({
      id: ref.threadId,
      title: `Conversation ${ref.threadId}`,
      environmentId: ref.environmentId,
      branch: "main",
      runtime: null,
      ...state.threads.get(`${ref.environmentId}:${ref.threadId}`),
    }),
  useProject: () => ({ title: "Project", workspaceRoot: "/projects/app" }),
}));
vi.mock("../state/threads", () => ({ useEnvironmentThread: state.detail }));
vi.mock("../state/environments", () => ({
  useEnvironment: (id: string) => ({ label: id === "remote" ? "Build server" : "This Mac" }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (
    select: (value: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => select({ threadLastVisitedAtById: state.visits }),
}));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));

import { threadSwitcher } from "../threadSwitching";
import { ThreadCycleShortcut } from "./ThreadCycleShortcut";

let root: Root;
let container: HTMLDivElement;
const navigate = vi.fn();
const keys = ["local:a", "local:b", "remote:c"];
const runtime = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-08T10:00:00.000Z",
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  navigate.mockClear();
  state.detail.mockReset().mockReturnValue(EMPTY_ENVIRONMENT_THREAD_STATE);
  state.visits = {};
  state.threads.clear();
  state.threads.set("local:b", { branch: "feature/editor", worktreePath: "/worktrees/editor" });
  threadSwitcher.cancel();
  keys.forEach((key) => threadSwitcher.visit(key));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
  container.querySelector("textarea")?.focus();
});

async function render(threadKeys = keys, onCommit = () => {}) {
  await act(() =>
    root.render(
      <Profiler id="switcher" onRender={onCommit}>
        <textarea aria-label="Draft" defaultValue="Unsent message" />
        <ThreadCycleShortcut
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          threadKeys={threadKeys}
          currentThreadKey="remote:c"
          terminalOpen={false}
          navigateToThread={navigate}
        />
      </Profiler>,
    ),
  );
}

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function key(type: "keydown" | "keyup", key: string, ctrlKey = true) {
  await act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent(type, { key, ctrlKey, bubbles: true, cancelable: true }),
    );
  });
}

function selectedTitle() {
  return document
    .querySelector('[role="option"][aria-selected="true"]')
    ?.getAttribute("aria-label");
}

function row(title = "Conversation b") {
  return document.querySelector<HTMLButtonElement>(`[role="option"][aria-label="${title}"]`);
}

describe("conversation switcher", () => {
  it("identifies workspaces immediately without loading transcripts or claiming they are empty", async () => {
    await key("keydown", "Tab");
    expect(row()?.textContent).toContain("Project");
    expect(row()?.textContent).toContain("feature/editor");
    expect(row()?.textContent).toContain("This Mac");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("/worktrees/editor");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("No messages yet");
    expect(state.detail).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("updates workspace context while cycling without navigating", async () => {
    await key("keydown", "Tab");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Worktree");
    await key("keydown", "ArrowDown");
    expect(selectedTitle()).toBe("Conversation a");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Project directory");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("/projects/app");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      "/worktrees/editor",
    );
    await key("keydown", "ArrowUp");
    expect(selectedTitle()).toBe("Conversation b");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses the worktree name without a branch and omits repeated machine labels", async () => {
    state.threads.set("local:b", { branch: null, worktreePath: "/worktrees/editor" });
    await render(["local:a", "local:b"]);
    await key("keydown", "Tab");
    expect(row()?.textContent).toContain("editor");
    expect(row()?.textContent).not.toContain("This Mac");
  });

  it("updates attention signals without changing selection or recency", async () => {
    state.threads.set("local:b", { runtime, hasPendingApprovals: true, hasPendingUserInput: true });
    await key("keydown", "Tab");
    expect(row()?.textContent).toContain("Needs approval");
    expect(row()?.textContent).not.toContain("Working");
    state.threads.set("local:b", { runtime, hasPendingUserInput: true });
    await render();
    expect(row()?.textContent).toContain("Needs input");
    expect(selectedTitle()).toBe("Conversation b");
    state.threads.set("local:b", { runtime });
    await render();
    expect(row()?.textContent).toContain("Working");
    await key("keydown", "Tab");
    expect(selectedTitle()).toBe("Conversation a");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("preserves unread completion during preview and respects the server visit watermark", async () => {
    const completed = {
      latestRun: {
        runId: RunId.make("run-b"),
        status: "completed" as const,
        assistantMessageId: null,
        requestedAt: "2026-10-08T09:00:00.000Z",
        startedAt: "2026-10-08T09:00:00.000Z",
        completedAt: "2026-10-08T09:05:00.000Z",
      },
      lastVisitedAt: "2026-10-08T09:01:00.000Z",
    };
    state.threads.set("local:b", completed);
    state.visits["local:b"] = "2026-10-08T10:00:00.000Z";
    await key("keydown", "Tab");
    expect(row()?.textContent).toContain("Unread");
    await key("keydown", "Escape");
    await key("keydown", "Tab");
    expect(row()?.textContent).toContain("Unread");
    expect(navigate).not.toHaveBeenCalled();
    state.threads.set("local:b", { ...completed, runtime });
    await render();
    expect(row()?.textContent).toContain("Working");
    expect(row()?.textContent).not.toContain("Unread");
  });

  it("previews while held, commits only the selection, and closes", async () => {
    await key("keydown", "Tab");
    expect(selectedTitle()).toBe("Conversation b");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("listbox"));
    await key("keydown", "Tab");
    expect(selectedTitle()).toBe("Conversation a");
    expect(navigate).not.toHaveBeenCalled();
    await key("keyup", "Control", false);
    expect(navigate.mock.calls).toEqual([["local:a"]]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe("Unsent message");
  });

  it("restores composer focus and preserves the draft when cancelled", async () => {
    await key("keydown", "Tab");
    await key("keydown", "Escape");
    await key("keyup", "Control", false);
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    expect(container.querySelector("textarea")?.value).toBe("Unsent message");
  });

  it("never presents a stale selection when the selected conversation is removed", async () => {
    await key("keydown", "Tab");
    expect(selectedTitle()).toBe("Conversation b");
    const openDialogs: string[] = [];
    await render(["local:a", "remote:c"], () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) openDialogs.push(dialog.textContent ?? "");
    });
    expect(openDialogs).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    await key("keyup", "Control", false);
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("Unsent message");
  });

  it("opens a clicked preview without committing a second time on release", async () => {
    await key("keydown", "Tab");
    const card = document.querySelector<HTMLButtonElement>(
      '[role="option"][aria-label="Conversation a"]',
    );
    expect(card).not.toBeNull();
    await act(() => card?.click());
    await key("keyup", "Control", false);
    expect(navigate.mock.calls).toEqual([["local:a"]]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
