import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const prompt = {
  requestId: RuntimeRequestId.make("selectable-question"),
  createdAt: "2026-10-07T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Copy ticket T3-16821 before choosing how to land the fix.",
      options: [
        {
          label: "Keep the native button",
          description: "Path apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx",
        },
      ],
      multiSelect: false,
    },
  ],
};
const onToggleOption = vi.fn();

function selectContents(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function textElement(container: ParentNode, selector: string, text: string) {
  return [...container.querySelectorAll(selector)].find((node) => node.textContent?.includes(text));
}

function renderPanel() {
  onToggleOption.mockClear();
  window.getSelection()?.removeAllRanges();
  return render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      disabled={false}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
    { router: false },
  );
}

it("keeps question copy selectable and ignores a click that finishes a selection", async () => {
  await using screen = await renderPanel();
  const { container } = screen;
  const question = textElement(container, "p", "T3-16821");
  const description = textElement(container, "span", "ComposerPendingUserInputPanel.tsx");
  const option = container.querySelector("[data-pending-user-input-option]");
  expect(question?.closest("button")).toBeNull();
  expect(description?.closest("button")).toBeNull();
  expect(option?.getAttribute("role")).toBe("button");

  selectContents(description!);
  await act(async () =>
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
  );
  expect(onToggleOption).not.toHaveBeenCalled();

  await act(async () =>
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })),
  );
  expect(onToggleOption).toHaveBeenCalledTimes(1);

  window.getSelection()?.removeAllRanges();
  await act(async () => (option as HTMLElement).click());
  expect(onToggleOption).toHaveBeenCalledTimes(2);

  const outside = document.createElement("p");
  outside.textContent = "elsewhere";
  document.body.append(outside);
  selectContents(outside);
  await act(async () => (option as HTMLElement).click());
  outside.remove();
  expect(onToggleOption).toHaveBeenCalledTimes(3);
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Keep the native button");
});

it("still chooses an option from the keyboard and keeps a selected collapsed question closed", async () => {
  await using screen = await renderPanel();
  const { container } = screen;
  const option = container.querySelector("[data-pending-user-input-option]") as HTMLElement;
  const repeatedSpace = new KeyboardEvent("keydown", {
    key: " ",
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => option.dispatchEvent(repeatedSpace));
  expect(repeatedSpace.defaultPrevented).toBe(true);
  expect(onToggleOption).not.toHaveBeenCalled();
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Keep the native button");

  const toggle = () =>
    container.querySelector("[data-pending-user-input-toggle]") as HTMLButtonElement;
  const row = container.querySelector("[data-composer-banner-row]") as HTMLElement;
  selectContents(textElement(container, "p", "T3-16821")!);
  await act(async () => row.click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("expanded");
  window.getSelection()?.removeAllRanges();
  await act(async () => toggle().click());
  const collapsedQuestion = textElement(
    container,
    "[data-pending-user-input-selectable]",
    "T3-16821",
  );
  expect(collapsedQuestion?.closest("button")).toBeNull();
  selectContents(collapsedQuestion!);
  await act(async () => (collapsedQuestion as HTMLElement).click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");

  const header = textElement(row, "span", "Approach")!;
  const range = document.createRange();
  range.setStart(header.firstChild!, 0);
  range.setEnd(collapsedQuestion!.firstChild!, collapsedQuestion!.textContent!.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => row.click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");

  window.getSelection()?.removeAllRanges();
  await act(async () => row.click());
  expect(toggle().dataset.pendingUserInputToggle).toBe("expanded");
});
