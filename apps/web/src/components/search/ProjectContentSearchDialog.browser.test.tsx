import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthFilesystemReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  readScope: vi.fn(),
  // The real query hands back the same result array until the search changes.
  matches: [
    {
      resultIndex: 0,
      path: "src/index.ts",
      lineNumber: 3,
      lineContent: "match",
      matchRanges: [],
    },
  ],
  noMatches: [],
  access: { canReadFiles: true, isCheckingAccess: false },
  listeners: new Set<() => void>(),
}));

// The real query is subscription-backed, so access changes reach the dialog without a parent render.
function setAccess(access: { canReadFiles: boolean; isCheckingAccess: boolean }) {
  state.access = access;
  for (const listener of state.listeners) listener();
}

const target = {
  environmentId: EnvironmentId.make("content-search-secondary"),
  cwd: "/project",
  projectName: "Project",
  threadRef: scopeThreadRef(
    EnvironmentId.make("content-search-secondary"),
    ThreadId.make("content-search-thread"),
  ),
};

vi.mock(import("~/hooks/useActiveProjectTarget"), async (original) => ({
  ...(await original()),
  useActiveProjectTarget: () => target,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: state.readScope,
}));
vi.mock(import("~/state/queries"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useProjectContentSearch: (({ query }: { query: string }) => {
      const { canReadFiles, isCheckingAccess } = useSyncExternalStore(
        subscribe,
        () => state.access,
      );
      return {
        canReadFiles,
        isCheckingAccess,
        error: null,
        isPending: isCheckingAccess,
        hasQuery: query.length > 0,
        truncated: false,
        invalidRegex: false,
        matches: canReadFiles && query.length > 0 ? state.matches : state.noMatches,
      };
    }) as never,
  };
});

import { useRightPanelStore } from "~/rightPanelStore";
import { ProjectContentSearchDialog } from "./ProjectContentSearchDialog";

let root: Root;
let container: HTMLDivElement;
const onOpenChange = vi.fn();
const openFile = vi.fn();

beforeEach(() => {
  state.access = { canReadFiles: true, isCheckingAccess: false };
  state.listeners.clear();
  state.readScope.mockReset().mockReturnValue(true);
  openFile.mockClear();
  onOpenChange.mockClear();
  vi.spyOn(useRightPanelStore.getState(), "openFile").mockImplementation(openFile);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector("input")!;
const result = () => container.querySelector<HTMLButtonElement>("[data-content-search-result]");

async function openSearch() {
  await act(() => root.render(<ProjectContentSearchDialog onOpenChange={onOpenChange} />));
}

async function type(text: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("enables search after access resolves and opens a result in its own environment", async () => {
  state.access = { canReadFiles: false, isCheckingAccess: true };
  await openSearch();
  expect(input().disabled).toBe(true);
  expect(container.textContent).toContain("Checking file access…");

  await act(() => setAccess({ canReadFiles: true, isCheckingAccess: false }));
  expect(input().disabled).toBe(false);
  await type("match");
  await act(async () => result()!.click());

  expect(state.readScope).toHaveBeenCalledWith(target.environmentId, AuthFilesystemReadScope);
  expect(openFile).toHaveBeenCalledWith(target.threadRef, "src/index.ts", 3);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it.each(["pointer", "keyboard"])(
  "rechecks access before a retained %s action opens a result",
  async (action) => {
    await openSearch();
    await type("match");

    state.readScope.mockReturnValue(false);
    await act(async () => {
      if (action === "pointer") result()!.click();
      else
        input().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });

    expect(state.readScope).toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  },
);
