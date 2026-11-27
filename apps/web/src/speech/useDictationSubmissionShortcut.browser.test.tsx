import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { useDictationSubmissionShortcut } from "./useDictationSubmissionShortcut";

function Probe({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  useDictationSubmissionShortcut({ enabled: true, formRef, onKeyDown });
  return (
    <>
      <div role="region" aria-label="Conversation" tabIndex={-1}>
        <div data-testid="timeline" tabIndex={0}>
          Earlier messages
        </div>
        <button type="button">Copy</button>
        <input aria-label="Search" />
      </div>
      <form ref={formRef}>
        <div data-testid="composer-editor" contentEditable={false} />
      </form>
    </>
  );
}

it.each([
  ["the conversation", "Conversation"],
  ["the message timeline", "timeline"],
])("submits dictation on Enter while %s has focus", async (_, target) => {
  const onKeyDown = vi.fn();
  await using screen = await render(<Probe onKeyDown={onKeyDown} />);
  const element =
    target === "timeline"
      ? screen.getByTestId("timeline").element()
      : screen.getByRole("region", { name: target }).element();
  (element as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onKeyDown).toHaveBeenCalledOnce();
});

it("leaves Enter to a focused button or field", async () => {
  const onKeyDown = vi.fn();
  await using screen = await render(<Probe onKeyDown={onKeyDown} />);
  (screen.getByRole("button", { name: "Copy" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  (screen.getByRole("textbox", { name: "Search" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onKeyDown).not.toHaveBeenCalled();
});
