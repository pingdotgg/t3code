import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { serverTabKey, useWorkspaceTabsStore } from "~/workspaceTabsStore";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

describe("WorkspaceTabs", () => {
  const envId = EnvironmentId.make("env-local");
  const threadId = ThreadId.make("thread-1");

  beforeEach(() => {
    useWorkspaceTabsStore.setState({
      tabs: [
        {
          key: serverTabKey(envId, threadId),
          kind: "server",
          environmentId: envId,
          threadId,
          title: "My Active Thread",
          projectId: ProjectId.make("project-1"),
          projectName: "Project Alpha",
        },
      ],
      activeTabKey: serverTabKey(envId, threadId),
    });
  });

  it("renders tabs container and active tab title", () => {
    const html = renderToStaticMarkup(
      <WorkspaceTabs
        activeThreadEnvironmentId={envId}
        activeThreadId={threadId}
        activeThreadTitle="My Active Thread"
        activeProjectName="Project Alpha"
        onNewTab={() => {}}
      />,
    );

    expect(html).toContain("data-workspace-tabs");
    expect(html).toContain("My Active Thread");
    expect(html).toContain('data-tab-key="new-thread"');
  });

  it("renders new thread tab", () => {
    const html = renderToStaticMarkup(
      <WorkspaceTabs
        activeThreadEnvironmentId={envId}
        activeThreadId={threadId}
        activeThreadTitle="My Active Thread"
        activeProjectName="Project Alpha"
        onNewTab={() => {}}
      />,
    );

    expect(html).toContain("New thread");
  });

  it("renders dedicated thread actions dropdown trigger only for active tab", () => {
    const inactiveThreadId = ThreadId.make("thread-2");
    useWorkspaceTabsStore.setState({
      tabs: [
        {
          key: serverTabKey(envId, threadId),
          kind: "server",
          environmentId: envId,
          threadId,
          title: "Active Thread",
          projectId: ProjectId.make("project-1"),
          projectName: "Project Alpha",
        },
        {
          key: serverTabKey(envId, inactiveThreadId),
          kind: "server",
          environmentId: envId,
          threadId: inactiveThreadId,
          title: "Inactive Thread",
          projectId: ProjectId.make("project-1"),
          projectName: "Project Alpha",
        },
      ],
      activeTabKey: serverTabKey(envId, threadId),
    });

    const html = renderToStaticMarkup(
      <WorkspaceTabs
        activeThreadEnvironmentId={envId}
        activeThreadId={threadId}
        activeThreadTitle="Active Thread"
        activeProjectName="Project Alpha"
        onNewTab={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Thread actions for Active Thread"');
    expect(html).not.toContain('aria-label="Thread actions for Inactive Thread"');
  });
});
