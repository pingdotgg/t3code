import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

const watchCommand = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({ realRows: false }));

// List-only cases isolate query-backed rows; the density case uses their real layout.
vi.mock(import("./ThreadDetailsPrRow"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ThreadDetailsPrRow: (props: ComponentProps<typeof actual.ThreadDetailsPrRow>) =>
      fixture.realRows ? (
        <actual.ThreadDetailsPrRow {...props} />
      ) : (
        <div data-row={String(props.number)}>
          {props.onStopWatching ? (
            <button onClick={props.onStopWatching}>Stop watching #{props.number}</button>
          ) : null}
        </div>
      ),
  };
});
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: () => [],
  useQuietThreadShell: (() => ({
    environmentId: "environment",
    projectId: "project",
    worktreePath: null,
  })) as never,
  useProject: (() => ({ workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => watchCommand) as never,
}));

vi.mock(import("./ChatCanvasContext"), async (original) => ({
  ...(await original()),
  useChatCanvas: (() => ({
    container: { width: 1800, height: 500 },
    lane: { padding: 48, minChatWidth: 640 },
    layout: { frame: null },
  })) as never,
}));
vi.mock(import("../../hooks/useT3ProjectFileScripts"), async (original) => ({
  ...(await original()),
  useT3ProjectFileScripts: () => [],
}));
vi.mock(import("./ThreadAutomationsPanel"), () => ({ ThreadAutomationsPanel: () => null }));
vi.mock(import("./ThreadRelationshipsControl"), () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock(import("../pullRequest/usePullRequestActions"), async (original) => ({
  ...(await original()),
  usePullRequestHandoffs: () => ({ handoff: null, startAsk: vi.fn(), startHandoff: vi.fn() }),
}));
vi.mock(import("../BranchToolbarBranchSelector"), () => ({
  BranchToolbarBranchSelector: () => (
    <ThreadDetailsPrRows
      threadRef={threadRef}
      links={manyLinks}
      currentLink={manyLinks[0]!}
      onOpenLink={vi.fn()}
      environmentId={threadRef.environmentId}
      pr={null}
      number={1}
      reference={manyLinks[0]!}
      status={null}
      project={null}
      label="#1"
      openAriaLabel="Open pull request #1"
      onOpen={vi.fn()}
    />
  ),
}));

import { PopoverCreateHandle } from "../ui/popover";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const manyLinks = Array.from({ length: 70 }, (_, i) =>
  link(i + 1, `branch-${i + 1}`, "main", "2026-01-01T00:00:00.000Z"),
);

function link(
  number: number,
  headBranch: string,
  baseBranch: string,
  updatedAt: string,
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: updatedAt,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch,
      baseBranch,
      isDraft: false,
      updatedAt,
      syncedAt: updatedAt,
    },
    stack: null,
  };
}

const bottom = link(1, "layer-one", "main", "2026-01-01T00:00:10.000Z");
const top = link(2, "layer-two", "layer-one", "2026-01-01T00:00:20.000Z");
const other = link(3, "unrelated", "main", "2026-01-01T00:00:05.000Z");

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fixture.realRows = false;
});

function render(links: ReadonlyArray<ThreadPullRequestLink>, current: ThreadPullRequestLink) {
  act(() => {
    root.render(
      <ThreadDetailsPrRows
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
        links={links}
        currentLink={current}
        onOpenLink={vi.fn()}
        environmentId={EnvironmentId.make("environment")}
        pr={null}
        number={current.number}
        reference={current}
        status={null}
        project={null}
        label={`#${current.number}`}
        openAriaLabel="Open pull request"
        onOpen={vi.fn()}
      />,
    );
  });
}

const rows = () =>
  [...container.querySelectorAll("[data-row]")].map((node) => node.getAttribute("data-row"));
const toggleButton = () =>
  [...container.querySelectorAll("button")].find((button) =>
    /^(Show \d+ more|Show less)$/.test(button.textContent?.trim() ?? ""),
  );
const toggleLabel = () => toggleButton()?.textContent?.trim();

function toggle() {
  act(() => toggleButton()!.click());
}

it("shows only the current pull request until the rest are asked for", () => {
  render([other, bottom, top], top);
  expect(rows()).toEqual(["2"]);
  expect(toggleLabel()).toBe("Show 2 more");

  toggle();
  expect(rows()).toEqual(["2", "1", "3"]);
  expect(toggleLabel()).toBe("Show less");

  toggle();
  expect(rows()).toEqual(["2"]);
  expect(toggleLabel()).toBe("Show 2 more");
});

it("keeps the single row untouched when the thread links one pull request", () => {
  render([bottom], bottom);
  expect(rows()).toEqual(["1"]);
  expect(toggleLabel()).toBeUndefined();
});

it("lets only watched pull requests stop their watch", () => {
  const watched: ThreadPullRequestLink = {
    ...bottom,
    watch: {
      startedAt: "2026-01-01T00:00:30.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-01-01T00:00:30.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    },
  };
  render([other, watched, top], top);
  toggle();
  const stopButtons = [...container.querySelectorAll("button")].filter((button) =>
    button.textContent?.startsWith("Stop watching"),
  );
  expect(stopButtons.map((button) => button.textContent)).toEqual(["Stop watching #1"]);

  act(() => stopButtons[0]!.click());
  expect(watchCommand).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("environment"),
    input: {
      threadId: ThreadId.make("thread"),
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 1,
      watching: false,
    },
  });
});

it("keeps workspace controls after expanding and collapsing 70 linked pull requests", async () => {
  fixture.realRows = true;
  container.style.cssText = "position:relative;width:1800px;height:500px";
  await act(async () => {
    root.render(
      <ThreadDetailsPanel
        {...threadRef}
        projectId={ProjectId.make("project")}
        worktreePath={null}
        isServerThread
        openInShortcutEnabled={false}
        anchor={{ current: null }}
        handle={PopoverCreateHandle()}
        onPresentationChange={vi.fn()}
        activeProjectName={undefined}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker
        openInShortcutEnabled={false}
        gitCwd="/tmp/project"
        isGitRepo
        envLocked={false}
        availableEnvironments={[]}
        onEnvironmentChange={vi.fn()}
        onEnvModeChange={vi.fn()}
        envMode="local"
        startFromOrigin={false}
        onStartFromOriginChange={vi.fn()}
        onComposerFocusRequest={vi.fn()}
        onRunProjectScript={vi.fn()}
        onAddProjectScript={vi.fn()}
        onUpdateProjectScript={vi.fn()}
        onDeleteProjectScript={vi.fn()}
      />,
    );
  });
  const runContext = page.getByRole("button", { name: "Run context" });
  const editor = page.getByRole("group", { name: "Open in editor" });
  await expect.element(runContext).toBeVisible();
  await expect.element(editor).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Show 69 more" }));
  await expect.element(page.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  const extraRows = () =>
    container.querySelectorAll('[aria-label^="https://github.com/pingdotgg/t3code/pull/"]');
  expect(extraRows()).toHaveLength(69);
  // Let native ResizeObserver deliver the expanded content size before collapsing it.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await userEvent.click(page.getByRole("button", { name: "Show less" }));
  await expect.element(page.getByRole("button", { name: "Show 69 more" })).toBeVisible();
  expect(extraRows()).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Open pull request #1" })).toBeVisible();
  await expect.element(runContext).toBeVisible();
  await expect.element(editor).toBeVisible();
});
