import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act, cloneElement, type PropsWithChildren, type ReactElement } from "react";
import { resolveThreadPullRequestBadge } from "@t3tools/shared/threadPullRequests";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  multiple: true,
  exists: true,
  openLinked: vi.fn(),
  cursor: null as string | null,
  olderText: "",
  dispatch: vi.fn(),
  links: [] as ThreadPullRequestLink[],
}));
const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const project = {
  id: ProjectId.make("project"),
  environmentId: threadRef.environmentId,
  repositoryIdentity: {
    provider: "github",
    host: "github.com",
    owner: "acme",
    name: "web",
    displayName: "acme/web",
    canonicalKey: "github.com/acme/web",
  },
};
const projects = [project];
const url = (number: number) => "https://github.com/acme/web/pull/" + number;
vi.mock("~/state/entities", () => ({
  useProjects: () => projects,
  useProject: () => project,
  useThreadShell: () =>
    state.exists
      ? {
          projectId: project.id,
          branchPullRequest: { url: url(1) },
          pullRequests: state.links,
        }
      : null,
  useServerConfigs: () =>
    new Map([
      [
        threadRef.environmentId,
        {
          environment: {
            capabilities: { threadPullRequests: state.multiple, threadPullRequestLinking: true },
          },
        },
      ],
    ]),
}));
vi.mock("~/state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/threads")>()),
  useEnvironmentThread: (environmentId: unknown) => ({
    status: "live",
    data: environmentId
      ? {
          _tag: "Some",
          value: { messages: [{ text: url(2) + " " + url(3) + " " + state.olderText }] },
        }
      : { _tag: "None" },
    page: state.cursor
      ? { _tag: "Some", value: { beforeCursor: state.cursor, hasMore: true, loadingOlder: false } }
      : { _tag: "None" },
  }),
}));
vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/threads")>()),
  requestOlderThreadTurns: vi.fn(),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (input: unknown) => state.dispatch(command, input),
}));
vi.mock("../ui/dialog", () => {
  const content = ({ children }: PropsWithChildren) => children;
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open && children,
    DialogDescription: content,
    DialogFooter: content,
    DialogHeader: content,
    DialogPanel: content,
    DialogPopup: content,
    DialogTitle: content,
  };
});
vi.mock("../ui/menu", () => {
  const content = ({ children }: PropsWithChildren) => children;
  return {
    Menu: ({
      children,
      onOpenChange,
    }: PropsWithChildren<{ onOpenChange: (open: boolean) => void }>) => (
      <div>
        <button aria-label="Link PRs" onClick={() => onOpenChange(true)} />
        {children}
      </div>
    ),
    MenuTrigger: () => null,
    MenuPopup: content,
    MenuGroup: content,
    MenuGroupLabel: content,
    MenuSeparator: () => null,
    MenuItem: "button",
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { requestOlderThreadTurns } from "@t3tools/client-runtime/state/threads";
import { threadEnvironment } from "~/state/threads";
import { toastManager } from "../ui/toast";
import { ThreadPullRequestControls } from "./ThreadPullRequestControls";
import { LinkPullRequestDialogHost, openLinkPullRequestDialog } from "./LinkPullRequestDialog";

let renderer: ReactTestRenderer;
function view() {
  return (
    <AppAtomRegistryProvider>
      <ThreadPullRequestControls
        threadRef={threadRef}
        active
        variant="underline"
        badge={resolveThreadPullRequestBadge(state.links)}
        number={1}
        url={url(1)}
        status={null}
        onOpenPullRequests={state.openLinked}
        onOpenPullRequest={() => {}}
      />
      <LinkPullRequestDialogHost />
    </AppAtomRegistryProvider>
  );
}
async function render() {
  await act(async () => {
    renderer = create(view());
  });
}
async function click(label: string) {
  await act(async () => {
    await renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === label || button.props.children === label)!
      .props.onClick({ preventDefault() {}, stopPropagation() {} });
  });
  await act(async () => {
    renderer.update(view());
  });
}
beforeEach(() => {
  state.multiple = true;
  state.exists = true;
  state.openLinked.mockClear();
  state.links = [];
  state.cursor = null;
  state.olderText = "";
  vi.mocked(requestOlderThreadTurns).mockClear();
  state.dispatch.mockReset().mockImplementation(async (command, { input }) => {
    if (command === threadEnvironment.linkPullRequest)
      state.links.push({ ...input, linkedAt: "2026-09-10T12:00:00Z", snapshot: null, stack: null });
    return { _tag: "Success" };
  });
  vi.mocked(toastManager.add).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
});
afterEach(async () => {
  await act(async () => {
    renderer?.root
      .findAllByType("button")
      .find((button) => button.props.children === "Cancel")
      ?.props.onClick();
    renderer?.unmount();
  });
  vi.unstubAllGlobals();
});

it("offers all thread PRs and links each separately while keeping the menu available", async () => {
  await render();
  await click("Show all 3 pull requests, 3 not linked");
  expect(state.openLinked).not.toHaveBeenCalled();
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(
    renderer.root
      .findAllByType("button")
      .filter((button) => (button.props["aria-label"] ?? "").startsWith("Link PR #")),
  ).toHaveLength(3);
  await click("Link PR #2");
  expect(state.dispatch.mock.calls.map(([, { input }]) => input.number)).toEqual([2]);
  expect(
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "PR #2 linked")?.props.disabled,
  ).toBe(true);
  await click("Link PR #3");
  expect(state.links.map((link) => link.number)).toEqual([2, 3]);
  await click("Show all 3 pull requests, 1 not linked");
  await click("Link PR #1");
  await click("Show all 3 linked pull requests; overall open");
  expect(state.openLinked).toHaveBeenCalledTimes(1);
  expect(
    state.dispatch.mock.calls.every(([command]) => command === threadEnvironment.linkPullRequest),
  ).toBe(true);
});

it("keeps a failed PR available for retry without adding other PRs", async () => {
  state.dispatch.mockRejectedValueOnce(new Error("Connection lost"));
  await render();
  await click("Link PRs");
  await click("Link PR #2");
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Connection lost" }),
  );
  expect(state.links).toHaveLength(0);
  await click("Link PR #2");
  expect(state.links.map((link) => link.number)).toEqual([2]);
});

it("adds a PR by project number without replacing an existing link", async () => {
  await render();
  await click("Link PRs");
  await click("Link PR #1");
  await act(async () => openLinkPullRequestDialog(threadRef));
  await act(async () =>
    renderer.root
      .findByProps({ placeholder: "Pull request URL or #42" })
      .props.onChange({ target: { value: "#4" } }),
  );
  await click("Link");
  expect(state.links.map((link) => link.number)).toEqual([1, 4]);
  expect(state.dispatch).toHaveBeenLastCalledWith(threadEnvironment.linkPullRequest, {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      host: "github.com",
      repository: "acme/web",
      number: 4,
      url: url(4),
      source: "manual",
    },
  });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});

it("keeps the existing PR badge without the removed shortcut on older servers", async () => {
  state.multiple = false;
  await render();
  expect(renderer.root.findAllByType("a").map((link) => link.props.href)).toEqual([url(1)]);
  expect(renderer.root.findAllByProps({ "aria-label": "Link PRs" })).toHaveLength(0);
  expect(state.dispatch).not.toHaveBeenCalled();
});

it("keeps the PR link but hides link actions until the draft thread exists", async () => {
  state.exists = false;
  await render();
  expect(renderer.root.findAllByType("a").map((link) => link.props.href)).toEqual([url(1)]);
  expect(renderer.root.findAllByProps({ "aria-label": "Link PRs" })).toHaveLength(0);
  expect(state.dispatch).not.toHaveBeenCalled();
});

it("loads older PR suggestions only when requested", async () => {
  state.cursor = "older-page";
  await render();
  await click("Link PRs");
  expect(requestOlderThreadTurns).not.toHaveBeenCalled();
  await click("Look for older PRs");
  expect(requestOlderThreadTurns).toHaveBeenCalledExactlyOnceWith(
    threadRef.environmentId,
    threadRef.threadId,
  );
  state.cursor = "oldest-page";
  state.olderText = url(4);
  await act(async () => {
    renderer.update(view());
  });
  expect(
    renderer.root
      .findAllByType("button")
      .some((button) => button.props["aria-label"] === "Link PR #4"),
  ).toBe(true);
  expect(requestOlderThreadTurns).toHaveBeenCalledTimes(1);
});
