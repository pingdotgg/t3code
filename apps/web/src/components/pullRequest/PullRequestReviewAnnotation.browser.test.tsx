import { EnvironmentId, ProjectId, type PullRequestReviewThread } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { registerCommands } from "~/shortcuts/dispatcher";
import { act, render } from "../../../test/render";
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
  expect(heard).toEqual([{ key: "Escape", consumed: true }]);

  await screen.getByRole("button", { name: "Reply", exact: true }).click();
  await reply().fill("Draft");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onReply).toHaveBeenCalledExactlyOnceWith("Draft");
});
