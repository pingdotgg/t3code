import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { MessageId, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { CHAT_REPLIES_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  assistantItem,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { replyContextField, subThreadDraftId } from "./subThreadReply";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function threadWithAgentSubThread(name: string) {
  const history = threadWithHistory(name, 1);
  const {
    messageId: _id,
    text: _text,
    streaming: _streaming,
    ...item
  } = assistantItem(history.id, history.runs[0]!.id, `${name}-news`, 2, "");
  const news = {
    ...item,
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "The deploy is done.", new_sub_thread: true },
    output: { ok: true },
  };
  // Only a message that already has replies takes a main-list Cite into its Replies.
  const reply = {
    ...item,
    id: TurnItemId.make(`${name}-reply`),
    ordinal: 3,
    type: "user_message" as const,
    messageId: MessageId.make(`${name}-reply`),
    text: "Which deploy?",
    attachments: [],
    inputIntent: "turn_start" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...replyContextField(news.id),
  };
  return { thread: { ...history, items: [...history.items, news, reply] }, first: news.id };
}

const layouts = {
  "side panel": { width: 1194, ...threadWithAgentSubThread("cite-side-panel") },
  sheet: { width: 414, ...threadWithAgentSubThread("cite-sheet") },
};
const threads = Object.values(layouts).map((layout) => layout.thread);
const settings = {
  threadDisplayModes: Object.fromEntries(
    threads.map((thread) => [thread.id, CHAT_REPLIES_DISPLAY_MODE.id]),
  ),
};

const waitForChatRepliesMode = () =>
  expect.element(page.getByRole("button", { name: /1 reply/ }).first()).toBeInTheDocument();

const selectWithPointer = (text: string) => userEvent.tripleClick(page.getByText(text));

it.each(Object.keys(layouts) as Array<keyof typeof layouts>)(
  "a Cite in the main list opens the replies of a message that has some in the %s, adds the quote to the saved reply draft and opens its comment box with focus",
  async (layout) => {
    const { width, thread, first } = layouts[layout];
    const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
    const replyDraft = subThreadDraftId(scopedThreadKey(threadRef), first)!;
    using _environment = installFakeEnvironment(threads, { settings });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    useComposerDraftStore.getState().setPrompt(replyDraft, "saved note");
    await page.viewport(width, 834);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    await waitForChatRepliesMode();
    await selectWithPointer("The deploy is done.");
    await page.getByRole("button", { name: "Cite selection in composer" }).click();

    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toBeInTheDocument();
    expect(document.querySelector(`[data-sub-thread-view="${first}"]`)).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector("[data-starting-style]")).toBeNull());
    await userEvent.keyboard("why?");
    await expect.element(comment).toHaveValue("why?");
    const reply = useComposerDraftStore.getState().getComposerDraft(replyDraft)?.prompt ?? "";
    expect(reply).toContain("saved note");
    expect(
      collectAssistantCitations(reply).map(({ citation }) => [citation.messageId, citation.text]),
    ).toEqual([[first, "The deploy is done."]]);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  },
);
