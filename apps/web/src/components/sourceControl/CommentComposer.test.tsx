import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { issueEnvironment } from "~/state/issues";
import { Textarea } from "../ui/textarea";
import { CommentComposer } from "./CommentComposer";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => post }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([false, true])(
  "keeps the draft unless the combined action posted it: %s",
  async (commentPosted) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let finish!: (result: { commentPosted: boolean }) => void;
    const response = new Promise<{ commentPosted: boolean }>((resolve) => {
      finish = resolve;
    });
    await act(() => {
      renderer = create(
        <CommentComposer
          environmentId={"local" as EnvironmentId}
          detail={{ projectId: "project" as ProjectId, repository: "acme/app", number: 1 }}
          label="Comment on this issue"
          command={issueEnvironment.comment}
          followUpAction="close"
          onCommentAction={() => response}
          onCommented={() => undefined}
        />,
      );
    });
    await act(() =>
      renderer.root.findByType(Textarea).props.onChange({ target: { value: "Done" } }),
    );
    const close = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Close with comment"));
    expect(close).toBeDefined();
    await act(() => {
      close!.props.onClick();
    });
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    await act(async () => {
      finish({ commentPosted });
      await response;
    });
    expect(renderer.root.findByType("textarea").props.value).toBe(commentPosted ? "" : "Done");
  },
);
