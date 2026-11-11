import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { makeThreadFixture } from "../../test-fixtures";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-test");

const state = vi.hoisted(() => ({ pullRequests: [] as ThreadPullRequestLink[] }));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() =>
    makeThreadFixture({
      environmentId,
      id: threadId,
      linkedPullRequest: null,
      branchPullRequest: null,
      pullRequests: state.pullRequests,
    })) as never,
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));

function link(repository: string, number: number, title: string): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "created",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: {
      state: "open",
      title,
      headBranch: "fix",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-02T00:00:00Z",
    },
  };
}

const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 600 } as const;

function Panel({ handle }: { handle: ReturnType<typeof PopoverCreateHandle> }) {
  return (
    <AppAtomRegistryProvider>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: placement,
        }}
      >
        <ThreadDetailsPanel
          anchor={{ current: null }}
          handle={handle}
          environmentId={environmentId}
          threadId={threadId}
          projectId={ProjectId.make("project-test")}
          worktreePath={null}
          isServerThread
          activeProjectName="multi-repo-folder"
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={[]}
          showOpenInPicker={false}
          openInShortcutEnabled={false}
          gitCwd="/workspace/multi-repo-folder"
          workspaceMutationId={null}
          isGitRepo={false}
          envLocked
          availableEnvironments={[]}
          onEnvModeChange={() => {}}
          envMode="local"
          startFromOrigin={false}
          onStartFromOriginChange={() => {}}
          onComposerFocusRequest={() => {}}
          onRunProjectScript={() => {}}
          onAddProjectScript={async () => ({ ok: true }) as never}
          onUpdateProjectScript={async () => ({ ok: true }) as never}
          onDeleteProjectScript={async () => ({ ok: true }) as never}
          usage={{ context: null, usage: null } as never}
        />
      </ChatCanvasContext>
    </AppAtomRegistryProvider>
  );
}

it("lists PRs the agent opened in child repos when the project root is not a git repo", async () => {
  state.pullRequests = [
    link("example/service-a", 200, "Batch identity calls"),
    link("example/service-b", 31, "Fix export columns"),
  ];
  await using screen = await render(<Panel handle={PopoverCreateHandle()} />);

  await expect.element(screen.getByText("#200: Batch identity calls")).toBeVisible();
  await screen.getByRole("button", { name: "Show 1 more" }).click();
  await expect.element(screen.getByText("#31: Fix export columns")).toBeVisible();
});
