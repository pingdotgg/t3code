import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  conversationSummarySourceKey,
  type ConversationSummary,
  type ConversationSummaryExpandInput,
  type ConversationSummaryList,
  type ConversationSummaryListInput,
  type ConversationSummarySourceRef,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  supported: null as unknown,
  searchSupported: null as unknown,
  focused: true,
  list: null as ConversationSummaryList | null,
  lists: [] as { environmentId: EnvironmentId; input: ConversationSummaryListInput }[],
  expansions: [] as { environmentId: EnvironmentId; input: ConversationSummaryExpandInput }[],
  longSource: "",
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => state.focused,
  useNavigation: () => ({ goBack: () => {} }),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: () => <header>Conversation summaries</header>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/conversationSummaries", () => ({
  conversationSummariesSupportedAtom: () => state.supported,
  conversationSummarySearchSupportedAtom: () => state.searchSupported,
  conversationSummaries: {
    list: (request: { environmentId: EnvironmentId; input: ConversationSummaryListInput }) => {
      state.lists.push(request);
      return state.list;
    },
    expand: (request: { environmentId: EnvironmentId; input: ConversationSummaryExpandInput }) => {
      state.expansions.push(request);
      const offset = request.input.offset ?? 0;
      const textOffset = request.input.textOffset ?? 0;
      const maxChars = request.input.maxChars ?? 12_000;
      const summary = state.list?.summaries[0];
      if (summary?.state !== "available") throw new Error("Expected summary");
      const firstPart = offset === 0 && textOffset === 0;
      return {
        summary,
        sources: summary.summary.sources
          .slice(offset, offset + (firstPart ? 1 : 6))
          .map((ref, index) => ({
            ref,
            result:
              offset + index === 0
                ? {
                    state: "available",
                    role: "assistant",
                    text: state.longSource.slice(textOffset, textOffset + maxChars),
                    textOffset,
                    totalChars: state.longSource.length,
                  }
                : offset + index === 1
                  ? { state: "unavailable", reason: "changed" }
                  : {
                      state: "available",
                      role: ref.kind === "turn_item" ? "tool" : "assistant",
                      text: "Exact source " + (offset + index + 1) + ": 日本語 🧪\n  unchanged.",
                    },
          })),
        nextOffset: firstPart ? 0 : offset === 0 ? 6 : null,
        nextTextOffset: firstPart ? maxChars : 0,
      };
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({ data, error: null, isPending: false }),
}));
vi.mock("../external-history/ExternalHistoryRouteScreen", () => ({
  ExternalHistoryThreadButton: () => null,
}));

import { ConversationSummariesRouteScreen } from "./ConversationSummariesRouteScreen";

function setup() {
  const supported = Atom.make(true);
  const registry = AtomRegistry.make();
  state.supported = supported;
  state.searchSupported = Atom.make(true);
  state.focused = false;
  state.lists = [];
  state.expansions = [];
  state.list = null;
  state.longSource =
    "Exact source 1: 日本語 🧪\n  unchanged.\n" + "x".repeat(12_000) + "\nFinal evidence.";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const rerender = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ConversationSummariesRouteScreen
            route={{
              params: { environmentId: "remote", projectId: "project", threadId: "thread" },
            }}
          />
        </RegistryContext.Provider>,
      ),
    );
  rerender();
  return {
    container,
    rerender,
    setSupported: (value: boolean) => act(() => registry.set(supported, value)),
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === label,
      );
      if (!button) throw new Error("Missing button: " + label);
      await act(async () => button.click());
    },
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    },
  };
}

it("reads only while open and supported, shows pass/citations/stale reasons and pages exact sources", async () => {
  using screen = setup();
  expect(state.lists).toEqual([]);
  state.focused = true;
  screen.setSupported(false);
  expect(state.lists).toEqual([]);
  expect(screen.container.textContent).toContain("Update the server");
  const sources = Array.from({ length: 10 }, (_, index): ConversationSummarySourceRef =>
    index === 9
      ? {
          kind: "turn_item",
          threadId: ThreadId.make("thread"),
          itemId: TurnItemId.make("tool-output"),
          digest: "a".repeat(64),
        }
      : {
          kind: "message",
          threadId: ThreadId.make("thread"),
          messageId: MessageId.make("message-" + (index < 2 ? 0 : index)),
          digest: "a".repeat(64),
          ...(index < 2
            ? {
                range: {
                  start: index * state.longSource.length,
                  end: (index + 1) * state.longSource.length,
                  total: state.longSource.length * 2,
                },
              }
            : {}),
        },
  );
  const summary: ConversationSummary = {
    id: "summary:" + "a".repeat(64),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
    sources,
    statements: [
      {
        text: "Keep the canonical sources.",
        citations: [sources[0]!, sources[1]!, sources[9]!].map(conversationSummarySourceKey),
      },
    ],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    createdAt: "2026-10-23T00:00:00Z",
  };
  const staleId = "summary:" + "b".repeat(64);
  state.list = {
    enabled: true,
    lastPass: {
      runId: RunId.make("run"),
      result: "failed",
      reason: "No model",
      generated: 0,
      waitingMessages: 10,
      at: summary.createdAt,
    },
    summaries: [
      { state: "available", summary },
      {
        state: "stale",
        id: staleId,
        sourceCount: 10,
        createdAt: summary.createdAt,
        reason: "changed",
      },
    ],
    nextCursor: staleId,
  };
  screen.setSupported(true);
  expect(state.lists.at(-1)).toEqual({
    environmentId: "remote",
    input: { projectId: "project", threadId: "thread", limit: 20 },
  });
  expect(state.expansions).toEqual([]);
  expect(screen.container.textContent).toContain(
    "Last pass failed. No model 10 older sources wait",
  );
  expect(screen.container.textContent).toContain("Keep the canonical sources. [#1, #2, #10]");
  expect(screen.container.textContent).toContain(
    "Outdated: source changed. The summary text is hidden",
  );
  await screen.click("Later summaries");
  expect(state.lists.at(-1)?.input.cursor).toBe(staleId);
  await screen.click("Earlier summaries");
  expect(state.lists.at(-1)?.input.cursor).toBeUndefined();
  await screen.click("Show sources");
  expect(state.expansions.at(-1)).toEqual({
    environmentId: "remote",
    input: {
      projectId: "project",
      threadId: "thread",
      summaryId: summary.id,
      offset: 0,
      textOffset: 0,
      limit: 6,
      maxChars: 12_000,
    },
  });
  expect(screen.container.textContent).toContain("Exact source 1: 日本語 🧪\n  unchanged.");
  expect(screen.container.textContent).not.toContain("Final evidence.");
  await screen.click("Next sources");
  expect(state.expansions.at(-1)?.input).toMatchObject({ offset: 0, textOffset: 12_000 });
  expect(screen.container.textContent).toContain("Final evidence.");
  expect(screen.container.textContent).not.toContain("Exact source 1:");
  expect(screen.container.textContent).toContain("Source changed.");
  await screen.click("Previous sources");
  expect(state.expansions.at(-1)?.input).toMatchObject({ offset: 0, textOffset: 0 });
  expect(screen.container.textContent).toContain("Exact source 1:");
  await screen.click("Next sources");
  await screen.click("Next sources");
  expect(state.expansions.at(-1)?.input.offset).toBe(6);
  expect(screen.container.textContent).toContain("#7 · Assistant");
  expect(screen.container.textContent).toContain("#10 · Tool");
  expect(screen.container.textContent).not.toContain("Exact source 1:");
  expect(
    [...screen.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next sources",
    )?.disabled,
  ).toBe(true);
  await screen.click("Previous sources");
  expect(state.expansions.at(-1)?.input).toMatchObject({ offset: 0, textOffset: 12_000 });
  await screen.click("Back to summaries");
  expect(screen.container.textContent).not.toContain("Exact source");
  await screen.click("Show sources");
  const listsBeforeCapabilityLoss = state.lists.length;
  const expansionsBeforeCapabilityLoss = state.expansions.length;
  screen.setSupported(false);
  expect(screen.container.textContent).toContain("Update the server");
  expect(screen.container.textContent).not.toContain("Exact source");
  screen.rerender();
  expect(state.lists).toHaveLength(listsBeforeCapabilityLoss);
  expect(state.expansions).toHaveLength(expansionsBeforeCapabilityLoss);
  screen.setSupported(true);
  state.focused = false;
  screen.rerender();
  const reads = state.lists.length;
  screen.rerender();
  expect(state.lists).toHaveLength(reads);
});
