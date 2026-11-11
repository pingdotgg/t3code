import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestCommentForm, type PullRequestQuoteRequest } from "./PullRequestCommentForm";

vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({ blocksSubmission: false, cancel: () => {} }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  pullRequestEnvironment: { comment: {} } as never,
}));

const detail = {
  provider: SourceControlProviderKind.make("github"),
  state: "open",
  capabilities: { actions: [] },
  viewerPermissions: { actions: [] },
} as unknown as PullRequestDetailView;
const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };

it("adds a quote that arrives as posting settles along with the ones queued before it", async () => {
  const form = (actionPending: boolean, quoteRequest: PullRequestQuoteRequest) => (
    <PullRequestCommentForm
      environmentId={EnvironmentId.make("test")}
      active
      reference={reference}
      detail={detail}
      actionPending={actionPending}
      textareaRef={createRef()}
      quoteRequest={quoteRequest}
      onCommentAction={vi.fn()}
      onCommented={vi.fn()}
      onClose={vi.fn()}
      onQuoted={vi.fn()}
    />
  );
  await using screen = await render(form(true, { text: "> first" }));
  await screen.rerender(form(true, { text: "> second" }));
  await screen.rerender(form(false, { text: "> third" }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("> second\n\n> third");
});
