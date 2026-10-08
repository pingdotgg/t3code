import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

const { shell, open } = vi.hoisted(() => ({ shell: vi.fn(), open: vi.fn() }));
vi.mock("~/state/entities", () => ({ useThreadShell: shell }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ open }) } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
});

it("opens the thread's linked items tab", async () => {
  shell.mockReturnValue({
    projectId: "project-1",
    issues: [
      {
        provider: "github",
        repository: "acme/app",
        number: 12,
        title: "Fix refresh",
        url: "https://github.com/acme/app/issues/12",
      },
    ],
  });
  await act(() => {
    renderer = create(<ThreadIssueLinks threadRef={ref} />);
  });
  await act(() => renderer.root.findByProps({ "aria-label": "Linked issues" }).props.onClick());
  expect(open).toHaveBeenCalledWith(ref, "pull-requests");
});

it("renders nothing for threads from older servers without issue links", async () => {
  shell.mockReturnValue({ projectId: "project-1" });
  await act(() => {
    renderer = create(<ThreadIssueLinks threadRef={ref} />);
  });
  expect(renderer.toJSON()).toBeNull();
});
