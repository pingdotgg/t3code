import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ThreadDetailsPrRow", () => ({
  ThreadDetailsPrRow: ({ number }: { number: number }) => <span data-row={String(number)} />,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/lib/openPullRequestLink", () => ({
  parseChangeRequestUrl: () => null,
  findProjectOnChangeRequestHost: () => undefined,
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

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function render(links: ReadonlyArray<ThreadPullRequestLink>, current: ThreadPullRequestLink) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <ThreadDetailsPrRows
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

const rows = () => renderer.root.findAllByType("span").map((node) => node.props["data-row"]);
const toggleLabel = () =>
  renderer.root
    .findAllByType("button")
    .at(-1)
    ?.children.filter((child) => typeof child === "string")
    .join("");

function toggle() {
  act(() => {
    (renderer.root.findAllByType("button").at(-1)!.props as { onClick: () => void }).onClick();
  });
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
