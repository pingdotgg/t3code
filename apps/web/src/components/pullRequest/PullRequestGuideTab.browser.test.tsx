import {
  EnvironmentId,
  ProjectId,
  type PullRequestRef,
  type PullRequestReviewGuide,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("./guide/useReviewGuideWriter"), () => ({ useReviewGuideWriter: vi.fn() }));
vi.mock(import("./guide/useGuideDiffFiles"), () => ({
  useGuideDiffFiles: () => ({ files: new Map(), loading: false, error: null, retry: () => {} }),
}));

import { render } from "../../../test/render";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { useChatShortcuts } from "../chat/useChatShortcuts";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import { PullRequestGuideTab } from "./PullRequestGuideTab";

const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 1,
};

const verboseFailure = [
  "Codex CLI command failed: OpenAI Codex v0.164.0",
  ...Array.from({ length: 200 }, (_, line) => `prompt line ${line}: read the change in order`),
  "ERROR: provider auth command `sh` timed out after 5000 ms",
].join("\n");

it("keeps Try again inside a short panel when a failed guide has long diagnostics", async () => {
  const write = vi.fn(async () => {});
  vi.mocked(useReviewGuideWriter).mockReturnValue({
    query: { isPending: false, error: null } as never,
    data: {
      guide: null,
      run: {
        _tag: "Failed",
        headSha: "head",
        failedAt: "2026-10-27T16:37:47.661Z",
        detail: verboseFailure,
      },
      currentHeadSha: "head",
    },
    running: false,
    canWrite: true,
    write,
  });
  const panel = document.createElement("div");
  panel.style.cssText = "position: relative; width: 480px; height: 360px; overflow: hidden";
  const tab = document.createElement("div");
  tab.style.cssText = "position: absolute; inset: 0";
  panel.append(tab);
  document.body.append(panel);
  using _panel = { [Symbol.dispose]: () => panel.remove() };

  await using screen = await render(
    <PullRequestGuideTab
      environmentId={EnvironmentId.make("environment")}
      reference={reference}
      title="Test pull request"
      workspaceRoot="/workspace"
      active
      canComment={false}
      rangeComments={false}
      completionScope={null}
      onAskAboutLines={null}
      onAskAboutStop={null}
      onFinishReview={null}
      onOpenFile={() => {}}
    />,
    { container: tab },
  );

  const retry = screen.getByRole("button", { name: "Try again" });
  await expect.element(retry).toBeVisible();
  const panelBox = panel.getBoundingClientRect();
  const retryBox = retry.element().getBoundingClientRect();
  expect(retryBox.top).toBeGreaterThanOrEqual(panelBox.top);
  expect(retryBox.bottom).toBeLessThanOrEqual(panelBox.bottom);

  await userEvent.click(retry);
  expect(write).toHaveBeenCalledOnce();
});

const threeStopGuide: PullRequestReviewGuide = {
  headSha: "head",
  generatedAt: "2026-11-07T00:00:00.000Z",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } as never,
  stops: ["First", "Second", "Third"].map((title) => ({
    title,
    summary: `Prose for the ${title.toLowerCase()} stop.`,
    attention: null,
    excerpts: [],
    files: [],
    notes: [],
    questions: [],
  })),
};

function ChatBeside({
  composerKeys,
  maximizedAway,
}: {
  composerKeys: string[];
  maximizedAway: boolean;
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return <div data-chat-column-maximized-away={maximizedAway ? "true" : "false"} />;
}

it("steps with J and K beside a chat, also after a stop button or while the chat is maximized away", async () => {
  vi.mocked(useReviewGuideWriter).mockReturnValue({
    query: { isPending: false, error: null } as never,
    data: { guide: threeStopGuide, run: null, currentHeadSha: "head" },
    running: false,
    canWrite: false,
    write: async () => {},
  });
  const composerKeys: string[] = [];

  const tree = (maximizedAway: boolean) => (
    <>
      <ChatBeside composerKeys={composerKeys} maximizedAway={maximizedAway} />
      <PullRequestGuideTab
        environmentId={EnvironmentId.make("environment")}
        reference={reference}
        title="Test pull request"
        workspaceRoot="/workspace"
        active
        canComment={false}
        rangeComments={false}
        completionScope={null}
        onAskAboutLines={null}
        onAskAboutStop={null}
        onFinishReview={null}
        onOpenFile={() => {}}
      />
    </>
  );
  await using screen = await render(tree(true));

  await userEvent.keyboard("j");
  await expect.element(screen.getByText("Prose for the second stop.")).toBeVisible();
  await screen.rerender(tree(false));
  await userEvent.click(screen.getByText("Prose for the second stop."));
  await userEvent.keyboard("k");
  await expect.element(screen.getByText("Prose for the first stop.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next stop" }));
  await userEvent.keyboard("j");
  await expect.element(screen.getByText("Prose for the third stop.")).toBeVisible();
  await userEvent.keyboard("k");
  await expect.element(screen.getByText("Prose for the second stop.")).toBeVisible();
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: "J", bubbles: true, cancelable: true, composed: true }),
  );
  await expect.element(screen.getByText("Prose for the third stop.")).toBeVisible();
  await userEvent.keyboard("a");
  expect(composerKeys).toEqual(["a"]);
});
