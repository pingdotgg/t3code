import { EnvironmentId, ProjectId, type PullRequestCheck } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const detailQuery = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { detail: () => ({}) } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: detailQuery.current, error: null, isPending: false }),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: () => null,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { UNREADABLE_CHECKS_EXPLANATION } from "./pullRequestPresentation";

const approval: PullRequestCheck = {
  name: "CI",
  status: "action-required",
  description: null,
  url: "https://github.com/acme/web/actions/runs/42",
};

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  detailQuery.current = null;
});

function texts(): ReadonlyArray<unknown> {
  return renderer.root
    .findAll((node) => node.type === "p" || node.type === "span")
    .flatMap((node) => node.children);
}

it("explains unreadable checks in the header popover instead of reporting none", () => {
  act(() => {
    renderer = create(
      <PullRequestChecksPopover checksState="passing" checks={[]} checksUnreadable />,
    );
  });
  expect(texts()).toContain(UNREADABLE_CHECKS_EXPLANATION);
  expect(texts()).not.toContain("No checks reported");
});

it("explains unreadable checks in a listing row and keeps the approval rows GitHub returned", () => {
  detailQuery.current = { checks: [approval], checksUnreadable: true };
  act(() => {
    renderer = create(
      <PullRequestChecksPopover
        checksState="pending"
        environmentId={EnvironmentId.make("env-1")}
        reference={{ projectId: ProjectId.make("project-1"), repository: "acme/web", number: 7 }}
      />,
    );
  });
  expect(texts()).toContain(UNREADABLE_CHECKS_EXPLANATION);
  expect(texts()).toContain("CI");
});
