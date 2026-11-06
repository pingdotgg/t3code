import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const renderPanel = async (voiceInputActive = false) => {
  const onToggleOption = vi.fn();
  const optionKeyRef: { current: ((key: string) => boolean) | null } = { current: null };
  const screen = await render(
    <div>
      <div data-testid="box" contentEditable suppressContentEditableWarning />
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: RuntimeRequestId.make("question-keys"),
            createdAt: "2026-10-23T00:00:00.000Z",
            dismissible: false,
            responseCapability: "live",
            questions: [
              {
                id: "format",
                header: "Format",
                question: "Which format?",
                multiSelect: false,
                options: [
                  { label: "CSV", description: "Comma separated" },
                  { label: "JSON", description: "One object" },
                ],
              },
            ],
          },
        ]}
        cwd={undefined}
        threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={() => {}}
        onDismiss={() => {}}
        voiceInputActive={voiceInputActive}
        optionKeyRef={optionKeyRef}
      />
    </div>,
  );
  return { screen, onToggleOption, optionKeyRef };
};

it("picks an option with a number key while focus is outside the box", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  await userEvent.keyboard("2");
  expect(onToggleOption).toHaveBeenCalledWith("format", "JSON");
});

it("leaves digits to an empty answer box", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  (screen.getByTestId("box").element() as HTMLElement).focus();
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
});

it("claims only the digits that have an option, so the rest stay text", async () => {
  const { screen, optionKeyRef } = await renderPanel();
  await using _ = screen;
  expect(optionKeyRef.current?.("2")).toBe(true);
  expect(optionKeyRef.current?.("7")).toBe(false);
  expect(optionKeyRef.current?.("a")).toBe(false);
});

it("takes no keys while dictation runs", async () => {
  const { screen, onToggleOption, optionKeyRef } = await renderPanel(true);
  await using _ = screen;
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
  expect(optionKeyRef.current).toBeNull();
});
