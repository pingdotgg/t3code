import { Atom } from "effect/reactivity";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { attachmentEnvironment } from "~/state/attachments";

const state = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock(import("@t3tools/client-runtime/review-attachments"), () => ({
  publishReviewAttachment: state.publish,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { capabilities: { attachments: true }, viewerPermissions: { attachments: true } },
  })) as never,
}));
import { PullRequestAttachments } from "./PullRequestAttachments";

function setup() {
  let finish!: (markdown: string) => void;
  state.publish.mockReset().mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  return { finish };
}

function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("Original");
  return (
    <div data-review-attachment-composer>
      <textarea ref={textareaRef} value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" onClick={() => setText("Original with dictation")}>
        Dictate
      </button>
      <PullRequestAttachments
        environmentId={EnvironmentId.make("attachment-race")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        textareaRef={textareaRef}
        onTextChange={setText}
      />
    </div>
  );
}

it("preserves edits received while an attachment is being published", async () => {
  const { finish } = setup();
  using _publishPermission = vi
    .spyOn(pullRequestEnvironment.uploadAttachment, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  using _transferPermission = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  await using screen = await render(<Composer />);
  const textarea = screen.container.querySelector("textarea")!;
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  const input = screen.container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["image"], "screen.png", { type: "image/png" })],
  });
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(state.publish).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Dictate" }).click();
  await act(() => finish("![screen](https://example.com/screen.png)"));
  expect(textarea.value).toContain("Original with dictation");
  expect(textarea.value).toContain("![screen](https://example.com/screen.png)");
});
