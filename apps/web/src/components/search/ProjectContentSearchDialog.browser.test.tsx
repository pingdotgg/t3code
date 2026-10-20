import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthFilesystemReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

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

function setup() {
  state.access = { canReadFiles: true, isCheckingAccess: false };
  state.listeners.clear();
  state.readScope.mockReset().mockReturnValue(true);
  const openFile = vi.fn();
  const onOpenChange = vi.fn();
  const openFileSpy = vi
    .spyOn(useRightPanelStore.getState(), "openFile")
    .mockImplementation(openFile);
  return { openFile, onOpenChange, [Symbol.dispose]: () => openFileSpy.mockRestore() };
}

const input = (screen: Screen) => screen.container.querySelector("input")!;
const result = (screen: Screen) =>
  screen.container.querySelector<HTMLButtonElement>("[data-content-search-result]");

function openSearch(onOpenChange: (open: boolean) => void) {
  return render(<ProjectContentSearchDialog onOpenChange={onOpenChange} />);
}

async function type(screen: Screen, text: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input(screen), text);
    input(screen).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("enables search after access resolves and opens a result in its own environment", async () => {
  using env = setup();
  state.access = { canReadFiles: false, isCheckingAccess: true };
  await using screen = await openSearch(env.onOpenChange);
  expect(input(screen).disabled).toBe(true);
  expect(screen.container.textContent).toContain("Checking file access…");

  await act(() => setAccess({ canReadFiles: true, isCheckingAccess: false }));
  expect(input(screen).disabled).toBe(false);
  await type(screen, "match");
  await act(async () => result(screen)!.click());

  expect(state.readScope).toHaveBeenCalledWith(target.environmentId, AuthFilesystemReadScope);
  expect(env.openFile).toHaveBeenCalledWith(target.threadRef, "src/index.ts", 3);
  expect(env.onOpenChange).toHaveBeenCalledWith(false);
});

it.each(["pointer", "keyboard"])(
  "rechecks access before a retained %s action opens a result",
  async (action) => {
    using env = setup();
    await using screen = await openSearch(env.onOpenChange);
    await type(screen, "match");

    state.readScope.mockReturnValue(false);
    await act(async () => {
      if (action === "pointer") result(screen)!.click();
      else
        input(screen).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });

    expect(state.readScope).toHaveBeenCalled();
    expect(env.openFile).not.toHaveBeenCalled();
    expect(env.onOpenChange).not.toHaveBeenCalled();
  },
);
