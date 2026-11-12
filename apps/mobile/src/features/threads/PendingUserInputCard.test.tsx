import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../lib/threadActivity";

const harness = vi.hoisted(() => ({
  navigate: [] as Array<[string, object | undefined]>,
  openedUrls: [] as string[],
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) => (
    <div onClick={onPress}>{children}</div>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const animation = { duration: () => ({ easing: () => ({}) }) };
  return {
    default: { View: ({ children }: Children) => <div>{children}</div> },
    Easing: { out: () => () => 0, cubic: () => 0 },
    FadeInUp: animation,
    FadeOutDown: animation,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value, set: () => {} }),
  };
});
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("./QuestionAttachments", () => ({ QuestionAttachments: () => null }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string; onLinkPress?: (href: string) => void }) => (
    <p>
      {[...props.markdown.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(([, label, href]) => (
        <button key={href} type="button" onClick={() => props.onLinkPress?.(href!)}>
          {label}
        </button>
      ))}
    </p>
  ),
}));
vi.mock("../../state/entities", () => ({
  useLiveThreadLinkLabels: (markdown: string) => markdown,
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedUrls.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: (name: string, params?: object) => harness.navigate.push([name, params]),
  }),
}));

import { PendingUserInputCard } from "./PendingUserInputCard";

function setup(questionMarkdown: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.navigate = [];
  harness.openedUrls = [];

  const pendingUserInput = {
    requestId: "request-1" as RuntimeRequestId,
    responseCapability: "resumable",
    questions: [
      {
        id: "question-1",
        header: "Review",
        question: questionMarkdown,
        options: [],
        allowCustomAnswer: false,
      },
    ],
  } as unknown as PendingUserInput;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <PendingUserInputCard
        environmentId={"env-1" as EnvironmentId}
        threadId={"thread-1" as ThreadId}
        workspaceRoot="/repo"
        canOperateThread
        pendingUserInput={pendingUserInput}
        maxHeight={{ value: 600 } as never}
        cardProgress={{ value: 1, set: () => {} } as never}
        cardCoverage={{ value: 0, set: () => {} } as never}
        collapsed={false}
        onToggleCollapsed={() => {}}
        drafts={{}}
        answers={null}
        respondingUserInputId={null}
        onSelectOption={() => {}}
        onChangeCustomAnswer={() => {}}
        onSubmit={async () => {}}
        onDismiss={async () => {}}
      />,
    ),
  );
  return {
    async pressLink(label: string) {
      const link = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!link) throw new Error(`No link labelled ${label}`);
      await act(async () => link.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("opens a workspace file link in a question in the thread's file viewer", async () => {
  using screen = setup("Should I update [probe.md](docs/probe.md:12)?");

  await screen.pressLink("probe.md");

  expect(harness.openedUrls).toEqual([]);
  expect(harness.navigate).toEqual([
    [
      "ThreadFile",
      { environmentId: "env-1", threadId: "thread-1", path: ["docs", "probe.md"], line: "12" },
    ],
  ]);
});
