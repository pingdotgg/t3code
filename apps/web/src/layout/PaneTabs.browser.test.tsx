import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import type { LayoutTab } from "./layoutModel";
import { useLayoutTabLabel } from "./PaneTabs";

const shells = new Map<string, unknown>();

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null ? null : (shells.get(ref.threadId) ?? null)) as never,
  useProject: (() => null) as never,
}));

function setup() {
  shells.clear();
  shells.set("subagent", {
    environmentId: "environment",
    id: "subagent",
    projectId: "project",
    title: "Child",
    lineage: { rootThreadId: "parent", parentThreadId: "parent", relationshipToParent: "subagent" },
  });
}

function chatTab(threadId: string, ghostOf?: null): LayoutTab {
  return {
    id: `tab-${threadId}`,
    content: {
      kind: "chat",
      target: {
        kind: "server",
        threadRef: scopeThreadRef("environment" as EnvironmentId, threadId as ThreadId),
      },
    },
    ...(ghostOf === undefined ? {} : { ghostOf }),
  };
}

function TabIcon({ tab }: { tab: LayoutTab }) {
  return <span data-testid="icon">{useLayoutTabLabel(tab).icon}</span>;
}

it("marks a subagent tab with the lineage icon however it was opened", async () => {
  setup();
  // A thread mention opens the subagent as an unlinked ghost (`ghostOf: null`) or a kept tab.
  for (const tab of [chatTab("subagent", null), chatTab("subagent")]) {
    await using screen = await render(<TabIcon tab={tab} />);
    await expect.element(screen.getByTestId("icon")).toContainHTML('class="lucide lucide-git-fork');
  }
});
