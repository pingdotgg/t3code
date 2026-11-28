import {
  EnvironmentId,
  ProjectId,
  type PullRequestRef,
  type PullRequestReviewGuide,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("./guide/useReviewGuideWriter"), () => ({ useReviewGuideWriter: vi.fn() }));
vi.mock(import("./guide/useGuideDiffFiles"), () => ({
  useGuideDiffFiles: () => ({ files: new Map(), loading: false, error: null, retry: () => {} }),
}));

import { render } from "../../../test/render";
import { RightPanelSheet } from "../RightPanelSheet";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { useChatShortcuts } from "../chat/useChatShortcuts";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import { GuideTour } from "./guide/GuideTour";
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

it("leaves J and K to floating layers, side chats, and IME while stepping inside a panel sheet", async () => {
  await using _screen = await render(
    <RightPanelSheet open animationDurationMs={0} onClose={() => {}}>
      <GuideTour
        environmentId={EnvironmentId.make("environment")}
        reference={{ ...reference, number: 2 }}
        guide={threeStopGuide}
        banner={null}
        active
        commenting={null}
        onAsk={null}
        onFinish={null}
        onOpenFile={() => {}}
      />
      <div role="dialog">
        <button>Dialog action</button>
      </div>
      <div role="menu">
        <button role="menuitem">Menu action</button>
      </div>
      <div data-slot="select-popup">
        <button>Popup action</button>
      </div>
      <div data-side-chat-pane>
        <button>Side chat action</button>
      </div>
      <button>IME action</button>
    </RightPanelSheet>,
  );
  await expect.element(page.getByRole("dialog", { name: "Workspace panel" })).toBeVisible();
  page.getByRole("button", { name: "Next stop" }).element().focus();
  await userEvent.keyboard("j");
  await expect.element(page.getByText("Prose for the second stop.")).toBeVisible();

  for (const [name, role, keyCode] of [
    ["Dialog action", "button", 0],
    ["Menu action", "menuitem", 0],
    ["Popup action", "button", 0],
    ["Side chat action", "button", 0],
    ["IME action", "button", 229],
  ] as const) {
    const target = page.getByRole(role, { name }).element();
    target.focus();
    for (const key of ["j", "k"]) {
      const event = new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented, `${name}: ${key}`).toBe(false);
    }
  }
  page.getByRole("button", { name: "Next stop" }).element().focus();
  await userEvent.keyboard("j");
  await expect.element(page.getByText("Prose for the third stop.")).toBeVisible();
});
