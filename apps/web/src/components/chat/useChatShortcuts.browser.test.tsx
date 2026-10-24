import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type PullRequestReviewGuide,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GuideTour } from "../pullRequest/guide/GuideTour";
import type { useReviewGuideWriter } from "../pullRequest/guide/useReviewGuideWriter";
import { PullRequestGuideTab } from "../pullRequest/PullRequestGuideTab";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

const focusOnMount = (element: HTMLElement | null) => element?.focus();

// Stands in for the right panel's launcher, which needs the whole app around it. Like the
// real one it takes focus, advertises its letters in `data-surface-launcher-keys`, and
// claims one from its own window capture listener unless the key was already handled.
function Launcher(props: { keys: string; received: string[] }) {
  useEffect(() => {
    const claim = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!props.keys.toLowerCase().split("").includes(event.key.toLowerCase())) return;
      event.preventDefault();
      props.received.push(event.key);
    };
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [props.keys, props.received]);
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={props.keys}
    />
  );
}

// The chat's shortcut listener registers when the chat mounts, so a launcher that opens
// later registers after it. Tests mount the chat first and add the launcher by rerendering.
function Chat(props: { composerKeys: string[]; launcher?: { keys: string; received: string[] } }) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    // Type-to-focus only calls insertTextAtEnd, so the stand-in composer implements just that.
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return props.launcher ? <Launcher {...props.launcher} /> : null;
}

// The guide tab's server query, swapped so a test can deliver the guide after mount.
const guideWriter = vi.hoisted(() => ({ guide: null as PullRequestReviewGuide | null }));
vi.mock(import("../pullRequest/guide/useReviewGuideWriter"), () => ({
  useReviewGuideWriter: () =>
    ({
      query: { isPending: false, error: null },
      data: { currentHeadSha: "head", run: null, guide: guideWriter.guide },
      running: false,
      canWrite: false,
      write: async () => {},
    }) as Partial<ReturnType<typeof useReviewGuideWriter>> as ReturnType<
      typeof useReviewGuideWriter
    >,
}));

// router: false because the chat shortcuts and the launcher stand-in never navigate.
const options = { router: false } as const;

it("leaves the launcher's letters to the launcher, in either case", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("tT");

  expect(received).toEqual(["t", "T"]);
  expect(composerKeys).toEqual([]);
});

it("still types other letters into the composer while the launcher is open", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("a");

  expect(composerKeys).toEqual(["a"]);
  expect(received).toEqual([]);
});

const guide: PullRequestReviewGuide = {
  headSha: "head",
  generatedAt: "2026-09-01T00:00:00Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  stops: ["First change", "Second change", "Third change"].map((title) => ({
    title,
    summary: "",
    attention: null,
    excerpts: [],
    files: [],
    notes: [],
    questions: [],
  })),
};

it("steps the review guide with J after clicking its prose instead of typing into the composer", async () => {
  const composerKeys: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(
    <>
      <Chat composerKeys={composerKeys} />
      <GuideTour
        environmentId={EnvironmentId.make("env-1")}
        reference={{ projectId: ProjectId.make("project-1"), repository: "acme/app", number: 1 }}
        guide={guide}
        banner={null}
        active
        engaged
        commenting={null}
        onAsk={null}
        onFinish={null}
        onOpenFile={() => {}}
      />
    </>,
  );
  await page.getByRole("heading", { name: "First change" }).click();

  await userEvent.keyboard("j");

  expect(composerKeys).toEqual([]);
  await expect.element(page.getByRole("heading", { name: "Second change" })).toBeVisible();
});

it("hands J between the chat and the guide by where the user last clicked", async () => {
  const composerKeys: string[] = [];
  // A PR of its own, so the tour does not resume where the previous test left it.
  const besideChat = () => (
    <>
      <Chat composerKeys={composerKeys} />
      <div data-chat-column data-testid="chat-transcript">
        Transcript
      </div>
      <div data-right-panel-tabbar>
        <button type="button">#2</button>
      </div>
      <div data-right-panel-surface-content>
        <PullRequestGuideTab
          environmentId={EnvironmentId.make("env-1")}
          reference={{ projectId: ProjectId.make("project-1"), repository: "acme/app", number: 2 }}
          title={null}
          workspaceRoot="/repo"
          active
          canComment={false}
          onAskAboutLines={null}
          onAskAboutStop={null}
          onFinishReview={null}
          onOpenFile={() => {}}
        />
      </div>
    </>
  );
  guideWriter.guide = null;
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(besideChat());
  await expect.element(page.getByText("No review guide yet", { exact: true })).toBeVisible();
  await page.getByTestId("chat-transcript").click();

  guideWriter.guide = guide;
  await screen.rerender(besideChat());
  await expect.element(page.getByRole("heading", { name: "First change" })).toBeVisible();
  await userEvent.keyboard("j");

  expect(composerKeys).toEqual(["j"]);
  await expect.element(page.getByRole("heading", { name: "First change" })).toBeVisible();

  await page.getByRole("heading", { name: "First change" }).click();
  await userEvent.keyboard("j");

  expect(composerKeys).toEqual(["j"]);
  await expect.element(page.getByRole("heading", { name: "Second change" })).toBeVisible();

  // The panel's own chrome, such as its already-active tab, re-engages the guide after the chat.
  await page.getByTestId("chat-transcript").click();
  await page.getByRole("button", { name: "#2" }).click();
  await userEvent.keyboard("j");

  expect(composerKeys).toEqual(["j"]);
  await expect.element(page.getByRole("heading", { name: "Third change" })).toBeVisible();
});
