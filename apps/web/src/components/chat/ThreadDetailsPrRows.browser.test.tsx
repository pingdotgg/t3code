import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const watchCommand = vi.hoisted(() => vi.fn());

// The row queries its own pull request; this test covers only which rows the list shows.
vi.mock(import("./ThreadDetailsPrRow"), async (importOriginal) => ({
  ...(await importOriginal()),
  ThreadDetailsPrRow: ({
    number,
    onStopWatching,
  }: {
    number: number;
    onStopWatching?: (() => void) | undefined;
  }) => (
    <div data-row={String(number)}>
      {onStopWatching ? <button onClick={onStopWatching}>Stop watching #{number}</button> : null}
    </div>
  ),
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: () => [],
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => watchCommand) as never,
}));

import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

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
