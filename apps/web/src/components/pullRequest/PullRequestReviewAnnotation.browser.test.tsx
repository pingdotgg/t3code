import { EnvironmentId, ProjectId, type PullRequestReviewThread } from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { initializeI18n } from "~/i18n/initializeI18n";
import { registerCommands } from "~/shortcuts/dispatcher";
import { act, render } from "../../../test/render";
import { RightPanelSheet } from "../RightPanelSheet";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";

const thread: PullRequestReviewThread = {
  id: "thread",
  path: "a.ts",
  line: 3,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: "comment",
      author: { login: "reviewer", name: null, avatarUrl: null },
      body: "Rename this.",
      createdAt: "2026-09-01T00:00:00Z",
      url: null,
    },
  ],
};

it("leaves IME keys in a review reply to the composition", async () => {
  const onReply = vi.fn(async () => true);
  await using screen = await render(
    <ReviewThreadCard
      thread={thread}
      workspaceRoot="/workspace"
      canReply
      canResolve={false}
      canReact={false}
      environmentId={EnvironmentId.make("environment")}
      reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
      completionScope={null}
      pending={false}
      onReply={onReply}
      onLoadMore={async () => null}
      canEditComment={() => false}
      onEditComment={async () => false}
      onToggleResolved={() => {}}
      onReacted={() => {}}
    />,
  );
  const heard: Array<{ key: string; consumed: boolean }> = [];
  using _observer = {
    [Symbol.dispose]: registerCommands(
      {},
      { observe: (event, consumed) => heard.push({ key: event.key, consumed }) },
    ),
  };
  const reply = () => screen.getByRole("textbox", { name: "Reply to this conversation" });
  await screen.getByRole("button", { name: "Reply", exact: true }).click();
  await reply().fill("Draft");

  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const keys of [
      { key: "Escape" },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", metaKey: true },
    ]) {
      const label = JSON.stringify({ ...keys, ...composing });
      const event = new KeyboardEvent("keydown", {
        ...keys,
        ...composing,
        bubbles: true,
        cancelable: true,
      });
      await act(() => reply().element().dispatchEvent(event));
      expect(event.defaultPrevented, label).toBe(false);
      // The pull requests page leaves on an Escape nothing consumed.
      expect(heard, label).toEqual([]);
      await expect.element(reply()).toHaveValue("Draft");
    }
  }
  expect(onReply).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  await expect.element(reply()).not.toBeInTheDocument();
  expect(heard).toEqual([]);

  await screen.getByRole("button", { name: "Reply", exact: true }).click();
  await reply().fill("Draft");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onReply).toHaveBeenCalledExactlyOnceWith("Draft");
});

it("Escape cancels a review reply without closing the right panel sheet", async () => {
  const onCloseSheet = vi.fn();
  await using _screen = await render(
    <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
      <ReviewThreadCard
        thread={thread}
        workspaceRoot="/workspace"
        canReply
        canResolve={false}
        canReact={false}
        environmentId={EnvironmentId.make("environment")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        completionScope={null}
        pending={false}
        onReply={async () => true}
        onLoadMore={async () => null}
        canEditComment={() => false}
        onEditComment={async () => false}
        onToggleResolved={() => {}}
        onReacted={() => {}}
      />
    </RightPanelSheet>,
  );
  await act(() =>
    (page.getByRole("button", { name: "Reply", exact: true }).element() as HTMLElement).focus(),
  );
  await userEvent.keyboard("{Enter}");
  const reply = page.getByRole("textbox", { name: "Reply to this conversation" });
  await reply.fill("Draft");

  await userEvent.keyboard("{Escape}");
  await expect.element(reply).not.toBeInTheDocument();
  expect(onCloseSheet).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onCloseSheet).toHaveBeenCalledOnce();
});

it("renders the outdated label in the UI language", async () => {
  const translations = await getTranslationsSnapshot("de");
  using _locale = {
    [Symbol.dispose]() {
      // GTProvider leaves its locale in a cookie; this sets it back to English.
      initializeI18n(() => {});
    },
  };
  await using screen = await render(
    <GTProvider locale="de" translations={translations}>
      <ReviewThreadCard
        thread={{ ...thread, isOutdated: true }}
        workspaceRoot="/workspace"
        canReply
        canResolve={false}
        canReact={false}
        environmentId={EnvironmentId.make("environment")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        completionScope={null}
        pending={false}
        onReply={async () => true}
        onLoadMore={async () => null}
        canEditComment={() => false}
        onEditComment={async () => false}
        onToggleResolved={() => {}}
        onReacted={() => {}}
      />
    </GTProvider>,
  );

  await expect.element(screen.getByText("Veraltet", { exact: true })).toBeVisible();
});
