import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as NodeModule from "node:module";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../lib/threadActivity";

const harness = vi.hoisted(() => ({
  dispatch: (_action: unknown) => {},
  navigate: (_name: string, _params?: object) => {},
  getState: (): unknown => undefined,
  getRoute: (): unknown => undefined,
  openURL: (_url: string): Promise<unknown> => Promise.resolve(true),
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) => (
    <div onClick={onPress}>{children}</div>
  ),
  Linking: { openURL: (url: string) => harness.openURL(url) },
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
  useProjects: () => [],
  useThreadShell: () => null,
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  const routers = requireNavigation("@react-navigation/routers");
  return {
    StackActions: routers.StackActions,
    CommonActions: routers.CommonActions,
    useNavigation: () => ({
      dispatch: harness.dispatch,
      navigate: harness.navigate,
      getState: harness.getState,
    }),
    useRoute: () => harness.getRoute(),
  };
});

import { PendingUserInputCard } from "./PendingUserInputCard";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions, CommonActions } = requireNavigation(
  "@react-navigation/routers",
) as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
};

function setup(questionMarkdown: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const router = StackRouter({});
  const options = {
    routeNames: ["Home", "Thread", "ThreadFile", "PullRequest"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  const openedUrls: string[] = [];
  harness.dispatch = (action) => dispatch(action as Parameters<typeof dispatch>[0]);
  harness.navigate = (name, params) => dispatch(CommonActions.navigate(name, params));
  harness.getState = () => state;
  harness.getRoute = () => state.routes.at(-1);
  harness.openURL = (url) => {
    openedUrls.push(url);
    return Promise.reject(new Error(`No activity found to handle ${url}`));
  };
  dispatch(StackActions.push("Thread", { environmentId: "env-1", threadId: "thread-1" }));

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
    openedUrls,
    get state() {
      return state;
    },
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

  expect(screen.openedUrls).toEqual([]);
  expect(screen.state.routes.at(-1)).toMatchObject({
    name: "ThreadFile",
    params: {
      environmentId: "env-1",
      threadId: "thread-1",
      path: ["docs", "probe.md"],
      line: "12",
    },
  });
});

it("opens an absolute file link under the workspace root by its workspace path", async () => {
  using screen = setup("Should I update [probe.md](/repo/docs/probe.md)?");

  await screen.pressLink("probe.md");

  expect(screen.openedUrls).toEqual([]);
  expect(screen.state.routes.at(-1)).toMatchObject({
    name: "ThreadFile",
    params: { environmentId: "env-1", threadId: "thread-1", path: ["docs", "probe.md"] },
  });
});
