import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

const { shell, update, openIssue } = vi.hoisted(() => ({
  shell: vi.fn(),
  update: vi.fn(async () => ({ _tag: "Success" })),
  openIssue: vi.fn(),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: shell }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => update }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openIssue }) } }));
vi.mock("../ui/popover", () => ({
  Popover: "div",
  PopoverPopup: "section",
  PopoverTitle: "h3",
  PopoverTrigger: "button",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const issue = {
  provider: "github",
  repository: "acme/app",
  number: 12,
  title: "Fix refresh",
  url: "https://github.com/acme/app/issues/12",
};
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
});

it("opens the linked issue in its thread environment and unlinks by identity", async () => {
  shell.mockReturnValue({ projectId: "project-1", issues: [issue] });
  await act(() => {
    renderer = create(<ThreadIssueLinks threadRef={ref} />);
  });
  const buttons = renderer.root.findAllByType("button");
  await act(() =>
    buttons
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes(issue.title)),
      )!
      .props.onClick(),
  );
  expect(openIssue).toHaveBeenCalledWith(ref, {
    environmentId: "remote",
    projectId: "project-1",
    provider: "github",
    repository: "acme/app",
    number: 12,
  });
  await act(() =>
    renderer.root.findByProps({ "aria-label": "Unlink Fix refresh" }).props.onClick(),
  );
  expect(update).toHaveBeenCalledWith({
    environmentId: "remote",
    input: {
      threadId: "thread-1",
      issueUnlink: { provider: "github", repository: "acme/app", number: 12 },
    },
  });
});

it("renders nothing for threads from older servers without issue links", async () => {
  shell.mockReturnValue({ projectId: "project-1" });
  await act(() => {
    renderer = create(<ThreadIssueLinks threadRef={ref} />);
  });
  expect(renderer.toJSON()).toBeNull();
});
