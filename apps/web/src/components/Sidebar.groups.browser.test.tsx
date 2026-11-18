import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("active");
const parentId = ThreadId.make("lead");

const project: Project = {
  id: projectId,
  environmentId,
  title: "active",
  workspaceRoot: "/projects/active",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};

function shell(
  id: string,
  title: string,
  overrides: { worker?: boolean; settled?: boolean } = {},
): EnvironmentThreadShell {
  return {
    ...makeThreadFixture({
      environmentId,
      projectId,
      id: ThreadId.make(id),
      title,
      ...(overrides.settled
        ? { settledOverride: "settled", settledAt: "2026-01-01T00:00:00.000Z" }
        : {}),
    }),
    ...(overrides.worker ? { groupParentThreadId: parentId } : {}),
  };
}

function mountGroup(threads: readonly EnvironmentThreadShell[], openThreadId?: string) {
  vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
  vi.mocked(useProjects).mockReturnValue([project]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue(
    openThreadId === undefined
      ? ({ kind: "none" } as never)
      : { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(openThreadId)) },
  );
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId, projectId },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: null,
  });
  return (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
}

const lastRowProps = (id: string) =>
  vi
    .mocked(SortableThreadRow)
    .mock.calls.map(([props]) => props)
    .findLast((props) => props.thread.id === id);

describe("sidebar thread groups", () => {
  it("workers render under their parent, not in their own section", async () => {
    await using screen = await render(
      mountGroup([
        shell("lead", "Lead thread"),
        shell("worker", "Worker thread", { worker: true }),
      ]),
    );

    await expect.element(screen.getByText("Worker thread").first()).toBeInTheDocument();
    expect(lastRowProps("lead")).toMatchObject({ groupRole: "parent", groupWorkerCount: 1 });
    expect(lastRowProps("worker")).toMatchObject({
      groupRole: "worker",
      groupMemberState: "live",
      sortableDisabled: true,
    });
    const anchors = [...screen.container.querySelectorAll("[data-thread-group-anchor]")];
    expect(anchors.map((anchor) => anchor.closest("li")?.textContent)).toEqual([
      expect.stringContaining("Worker thread"),
    ]);
  });

  it("a settled worker stays inside its live group", async () => {
    await using screen = await render(
      mountGroup([
        shell("lead", "Lead thread"),
        shell("worker", "Worker thread", { worker: true, settled: true }),
      ]),
    );

    await expect.element(screen.getByText("Worker thread").first()).toBeVisible();
    expect(lastRowProps("worker")).toMatchObject({
      groupRole: "worker",
      groupMemberState: "settled",
      variantAction: "unsettle",
    });
    expect(lastRowProps("lead")).toMatchObject({ variant: "card", variantAction: "settle" });
  });

  it("collapsing the parent hides workers and shows the count", async () => {
    using stack = new DisposableStack();
    stack.defer(() =>
      useUiStateStore.getState().setProjectExpanded("thread-group:local:lead", true),
    );
    await using screen = await render(
      mountGroup([
        shell("lead", "Lead thread"),
        shell("worker", "Worker thread", { worker: true }),
      ]),
    );
    await expect.element(screen.getByText("Worker thread").first()).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Collapse group" }));

    await expect.element(screen.getByText("Worker thread").first()).not.toBeInTheDocument();
    expect(lastRowProps("lead")).toMatchObject({ groupExpanded: false, groupWorkerCount: 1 });
    await expect
      .element(screen.getByRole("button", { name: "Expand group" }))
      .toHaveTextContent("1");
  });

  it("a settled lead with a live worker offers Un-settle", async () => {
    await using screen = await render(
      mountGroup([
        shell("lead", "Lead thread", { settled: true }),
        shell("worker", "Worker thread", { worker: true }),
      ]),
    );

    await expect.element(screen.getByText("Lead thread").first()).toBeVisible();
    expect(lastRowProps("lead")).toMatchObject({
      variantAction: "unsettle",
      leadState: "settled",
    });
  });

  it("an open worker inside a collapsed group stays visible", async () => {
    using stack = new DisposableStack();
    useUiStateStore.getState().setProjectExpanded("thread-group:local:lead", false);
    stack.defer(() =>
      useUiStateStore.getState().setProjectExpanded("thread-group:local:lead", true),
    );
    await using screen = await render(
      mountGroup(
        [shell("lead", "Lead thread"), shell("worker", "Worker thread", { worker: true })],
        "worker",
      ),
    );

    await expect.element(screen.getByText("Worker thread").first()).toBeVisible();
    expect(lastRowProps("lead")).toMatchObject({ groupExpanded: true });
  });

  it("a lead in the Settled shelf can expand its group", async () => {
    using stack = new DisposableStack();
    stack.defer(() =>
      useUiStateStore.getState().setProjectExpanded("thread-group:local:lead", true),
    );
    await using screen = await render(
      mountGroup(
        [
          shell("lead", "Lead thread", { settled: true }),
          shell("worker", "Worker thread", { worker: true, settled: true }),
        ],
        "lead",
      ),
    );

    expect(lastRowProps("lead")).toMatchObject({ variant: "slim", groupRole: "parent" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse group" }));
    await expect.element(screen.getByText("Worker thread").first()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand group" }));
    await expect.element(screen.getByText("Worker thread").first()).toBeVisible();
  });
});
