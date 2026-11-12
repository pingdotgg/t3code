import { createRef } from "react";
import { EnvironmentId, ProjectId, PullRequestOperationError } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { PullRequestCommentForm } from "./PullRequestCommentForm";

const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn() }));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({
    blocksSubmission: false,
    preparing: false,
    freezesEditor: false,
    cancel: () => {},
    submitAfterDictation: (submit: (text: string) => void) => submit("Looks good."),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.post }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

it("shows the host's reason when the host refuses the comment", async () => {
  const reason = "GitHub returned an error: Resource not accessible by integration";
  mocks.toast.mockReset();
  mocks.post.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(new PullRequestOperationError({ operation: "comment", detail: reason })),
    ),
  );
  const detail = {
    state: "open",
    capabilities: { actions: [] },
    viewerPermissions: { actions: [] },
  } as never;
  await using screen = await render(
    <PullRequestCommentForm
      active
      environmentId={EnvironmentId.make("test")}
      reference={{ projectId: ProjectId.make("test"), repository: "test/repo", number: 1 }}
      detail={detail}
      actionPending={false}
      textareaRef={createRef()}
      onCommentAction={vi.fn()}
      onCommented={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await screen.getByRole("textbox").fill("Looks good.");
  await screen.getByRole("button", { name: "Comment", exact: true }).click();
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: reason }),
    ),
  );
});
