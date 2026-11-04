import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  suggest: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
  useIsFocused: () => true,
  useNavigation: () => ({ dispatch: vi.fn() }),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { suggestSplit: { permissionAtom: () => true } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.suggest }));
vi.mock("../../state/use-composer-drafts", () => ({
  createNewTaskDraft: () => "draft-new",
  getComposerDraftSnapshot: () => ({ text: "", attachments: [], context: undefined }),
  setComposerDraftText: vi.fn(),
  updateComposerDraftSettings: vi.fn(),
}));

import { ThreadSplitSuggestion } from "./ThreadSplitSuggestion";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-test");
const projectId = ProjectId.make("project-test");

function mount(key: string, message: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadSplitSuggestion
        key={key}
        environmentId={environmentId}
        threadId={threadId}
        projectId={projectId}
        draftKey="draft-test"
        message={message}
        enabled
      />,
    ),
  );
  return { container, root };
}

describe("ThreadSplitSuggestion", () => {
  it("keeps a dismissed suggestion hidden across remounts until the draft is cleared", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    try {
      state.suggest.mockResolvedValue({ _tag: "Success", value: { suggest: true } });
      const first = mount("a", "Write release notes");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(state.suggest).toHaveBeenCalledTimes(1);
      const dismiss = first.container.querySelector("button:last-of-type");
      expect(first.container.textContent).toContain("Start a new thread");
      act(() => dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(first.container.textContent).not.toContain("Start a new thread");
      act(() => first.root.unmount());

      const second = mount("b", "Write release notes");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(state.suggest).toHaveBeenCalledTimes(1);
      expect(second.container.textContent).not.toContain("Start a new thread");
      act(() => second.root.unmount());

      const cleared = mount("c", "");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      act(() => cleared.root.unmount());

      const fresh = mount("d", "A different draft");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(state.suggest).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.resolve();
      });
      expect(fresh.container.textContent).toContain("Start a new thread");
      act(() => fresh.root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});
