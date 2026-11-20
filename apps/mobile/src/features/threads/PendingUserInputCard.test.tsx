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
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Path: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("../../components/StatusBadgeDot", () => ({ WithStatusBadgeDot: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {}, mutedNativeTextStyle: {} }),
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

import { AUTO_ADVANCE_MS, PendingUserInputCard } from "./PendingUserInputCard";

function setup(
  questionMarkdown: string,
  options?: {
    readonly steps?: number;
    readonly onStepChange?: (step: number) => void;
    readonly typedAnswer?: string;
    readonly allowCustomAnswer?: boolean;
  },
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.navigate = [];
  harness.openedUrls = [];

  const pendingUserInput = {
    requestId: "request-1" as RuntimeRequestId,
    responseCapability: "resumable",
    questions: Array.from({ length: options?.steps ?? 1 }, (_, index) =>
      options?.steps
        ? {
            id: `question-${index}`,
            header: "Pick",
            question: `Question ${index + 1}`,
            options: [{ label: "Yes", description: "Do it" }],
            multiSelect: false,
            allowCustomAnswer: options.allowCustomAnswer ?? true,
          }
        : {
            id: "question-1",
            header: "Review",
            question: questionMarkdown,
            options: [],
            allowCustomAnswer: false,
          },
    ),
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
        typedAnswer={options?.typedAnswer}
        step={0}
        onStepChange={options?.onStepChange ?? (() => {})}
        drafts={{}}
        respondingUserInputId={null}
        canSubmit={false}
        onSubmit={async () => {}}
        onSelectOption={() => {}}
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
    async pressText(label: string) {
      const target = [...container.querySelectorAll("span")].find(
        (span) => span.textContent === label,
      );
      if (!target) throw new Error(`No text labelled ${label}`);
      await act(async () => target.click());
    },
    hasText(label: string) {
      return [...container.querySelectorAll("span")].some((span) => span.textContent === label);
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

it("shows what is typed in the prompt box as the answer, unless custom answers are off", () => {
  {
    using screen = setup("", { steps: 1, typedAnswer: "Ship it" });
    expect(screen.hasText("Your answer")).toBe(true);
    expect(screen.hasText("Ship it")).toBe(true);
  }
  using off = setup("", { steps: 1, typedAnswer: "Ship it", allowCustomAnswer: false });
  expect(off.hasText("Your answer")).toBe(false);
});

it("moves to the next question shortly after a single-choice pick", async () => {
  vi.useFakeTimers();
  try {
    const steps: number[] = [];
    using screen = setup("", { steps: 2, onStepChange: (step) => steps.push(step) });

    await screen.pressText("Yes");
    expect(steps).toEqual([]);
    await act(async () => vi.advanceTimersByTime(AUTO_ADVANCE_MS));
    expect(steps).toEqual([1]);
  } finally {
    vi.useRealTimers();
  }
});
