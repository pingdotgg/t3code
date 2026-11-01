import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { makeComposerMentionDragHandlers } from "./chat/composerMentionDrag";
import { ThreadPullRequestBadgeControl, type ThreadPr } from "./ThreadStatusIndicators";
import { InlineButton } from "./ui/button";

const pr = {
  number: 122,
  url: "https://github.com/pingdotgg/t3code/pull/122",
  title: "Fix sidebar drag",
  headRef: "fix/sidebar-drag",
  baseRef: "main",
  state: "open",
  isDraft: false,
} satisfies ThreadPr;

it("drags a PR badge as a composer reference with a #number text fallback", async () => {
  await using screen = await render(
    <ThreadPullRequestBadgeControl
      render={<InlineButton />}
      badge={null}
      pullRequests={[]}
      number={pr.number}
      url={pr.url}
      pr={pr}
      status={null}
      onOpenList={() => {}}
      onOpenPullRequest={() => {}}
    />,
  );
  const badge = screen.getByRole("link", { name: "PR #122, status pending" });
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/html", "<span>122</span>");
  badge.element().dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));

  expect(dataTransfer.getData("text/plain")).toBe("#122");
  expect(dataTransfer.getData("text/uri-list")).toBe(pr.url);
  expect(dataTransfer.getData("text/html")).toBe("");

  const insertPullRequestAtEnd = vi.fn(() => true);
  const insertMentionAtEnd = vi.fn(() => true);
  const onInsertRejected = vi.fn();
  makeComposerMentionDragHandlers({
    insertPullRequestAtEnd,
    insertMentionAtEnd,
    setDragActive: () => {},
    onInsertRejected,
  }).onDrop({
    dataTransfer,
    nativeEvent: { stopPropagation() {} },
    preventDefault() {},
    stopPropagation() {},
  });

  expect(insertPullRequestAtEnd).toHaveBeenCalledWith({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headBranch: pr.headRef,
    baseBranch: pr.baseRef,
    state: pr.state,
    isDraft: pr.isDraft,
  });
  expect(insertMentionAtEnd).not.toHaveBeenCalled();
  expect(onInsertRejected).not.toHaveBeenCalled();
});
