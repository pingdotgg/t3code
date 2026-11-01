import { act, render as renderScreen, type Screen } from "../../../test/render";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { Fragment, Suspense, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { commands, linksByThread, Wrapper, Trigger } = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; request: unknown }>,
  // Linked pull requests per scoped thread key.
  linksByThread: new Map<string, ThreadPullRequestLink[]>(),
  Wrapper: ({ children }: { children?: ReactNode }) => children,
  Trigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/state/pullRequests", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    useSharedPullRequestSummary: () => null,
    pullRequestEnvironment: {
      changeBreakdown: () => null,
      runAction: { permissionAtom: () => Atom.make(false) },
    },
  };
});
// The panel's list behavior is exercised without the virtualizer's browser geometry.
vi.mock("@legendapp/list/react", () => ({
  LegendList: <T,>({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: ReadonlyArray<T>;
    renderItem: (input: { item: T; index: number }) => ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) =>
    data.map((item, index) => (
      <Fragment key={keyExtractor(item, index)}>{renderItem({ item, index })}</Fragment>
    )),
}));
vi.mock("~/state/entities", () => ({
  readProject: () => null,
  readProjects: () => [],
  readThreadShell: () => null,
  readThreadShells: () => [],
  useQuietThreadShell: () => null,
  // No projects, so rows offer no project-scoped fast actions.
  useProjects: () => [],
  // The other environment has no connected server configuration.
  useServerConfigs: () =>
    new Map(
      ["environment-new"].map((environmentId) => [
        environmentId,
        {
          environment: {
            capabilities: { threadPullRequests: environmentId === "environment-new" },
          },
        },
      ]),
    ),
  useThreadShell: (threadRef: ScopedThreadRef) => ({
    pullRequests: linksByThread.get(scopedThreadKey(threadRef)) ?? [],
  }),
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { unlinkPullRequest: "unlink", watchPullRequest: "watch" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (request: unknown) => {
    commands.push({ command, request });
  },
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => null,
  useOpenPrLink: () => vi.fn(),
}));
vi.mock("~/shortcutModifierState", () => ({
  useShortcutModifierState: () => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  }),
}));
vi.mock("~/components/pullRequest/LinkPullRequestDialog", () => ({
  openLinkPullRequestDialog: vi.fn(),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipTrigger: Trigger,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: Wrapper,
  MenuPopup: Wrapper,
  MenuGroup: Wrapper,
  MenuRadioGroup: Wrapper,
  MenuRadioItem: "button",
  MenuTrigger: Trigger,
  MenuItem: "button",
  MenuSeparator: () => null,
}));

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

// The same thread id on two environments is two threads.
const threadId = ThreadId.make("thread-a");
const refOn = (environmentId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId,
});
const link = (repository: string, number: number): ThreadPullRequestLink => ({
  host: "github.com",
  repository,
  number,
  url: `https://github.com/${repository}/pull/${number}`,
  source: "manual",
  linkedAt: "2026-09-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
});

const panelFor = (threadRef: ScopedThreadRef) => {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  return (
    <PanelHostContext value={host}>
      <Suspense fallback={null}>
        <RegisteredSidePanel id="pull-requests" />
      </Suspense>
    </PanelHostContext>
  );
};

// One root across hosts, so a host change reaches the already mounted list.
async function renderFor(screen: Screen, threadRef: ScopedThreadRef) {
  await screen.rerender(panelFor(threadRef));
  const expected =
    threadRef.environmentId === "environment-new"
      ? "owner/alpha"
      : "Linked pull requests unavailable";
  if (threadRef.environmentId === "environment-new") {
    const first = linksByThread.get(scopedThreadKey(threadRef))?.[0];
    await expect
      .element(screen.getByText(first?.repository ?? expected, { exact: false }).first())
      .toBeVisible();
  } else {
    await expect.element(screen.getByText(expected, { exact: true })).toBeVisible();
  }
}

const hasText = (screen: Screen, text: string) =>
  screen.container.textContent?.includes(text) ?? false;

describe("linked pull requests side panel", () => {
  it("lists and unlinks the host thread's pull requests", async () => {
    resetFixture();
    await import("./PullRequestsSidePanel");
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await renderFor(screen, refOn("environment-new"));
    expect(hasText(screen, "owner/alpha")).toBe(true);
    expect(hasText(screen, "owner/beta")).toBe(false);

    const unlink = Array.from(screen.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (node) => node.textContent?.includes("Unlink from thread"),
    );
    expect(unlink).toBeDefined();
    await act(async () => unlink!.click());
    expect(commands).toEqual([
      {
        command: "unlink",
        request: {
          environmentId: "environment-new",
          input: { threadId, host: "github.com", repository: "owner/alpha", number: 11 },
        },
      },
    ]);
  });

  it("follows the host to a thread whose environment cannot link pull requests", async () => {
    resetFixture();
    await import("./PullRequestsSidePanel");
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
    await using screen = await renderScreen(null, { router: false });
    await renderFor(screen, refOn("environment-new"));
    expect(hasText(screen, "owner/alpha")).toBe(true);

    await renderFor(screen, refOn("environment-old"));
    expect(hasText(screen, "Linked pull requests unavailable")).toBe(true);
    expect(hasText(screen, "owner/alpha")).toBe(false);
    expect(hasText(screen, "owner/beta")).toBe(false);

    linksByThread.set(scopedThreadKey(refOn("environment-new")), [link("owner/gamma", 33)]);
    await renderFor(screen, refOn("environment-new"));
    expect(hasText(screen, "owner/gamma")).toBe(true);
  });
});

function resetFixture() {
  commands.length = 0;
  linksByThread.clear();
  linksByThread.set(scopedThreadKey(refOn("environment-new")), [link("owner/alpha", 11)]);
  linksByThread.set(scopedThreadKey(refOn("environment-old")), [link("owner/beta", 22)]);
}
