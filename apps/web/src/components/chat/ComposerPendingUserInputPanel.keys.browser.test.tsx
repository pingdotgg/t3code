import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import { installSidebarTree, releaseSidebarRowFocus } from "../../lib/sidebarTree";
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

it("leaves digits to an interactive element outside the panel", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
  outside.remove();
});

it("still picks with a digit while an option inside the panel has focus", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  (screen.getByRole("button", { name: /CSV/ }).element() as HTMLElement).focus();
  await userEvent.keyboard("2");
  expect(onToggleOption).toHaveBeenCalledWith("format", "JSON");
});

it("leaves digits alone while a menu is open", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  const menu = document.createElement("div");
  menu.dataset.slot = "menu-popup";
  menu.toggleAttribute("data-open", true);
  document.body.append(menu);
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
  menu.remove();
});

it("leaves digits to a secret request", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  const secret = document.createElement("div");
  secret.dataset.v2ItemType = "secret_request";
  secret.tabIndex = 0;
  document.body.append(secret);
  secret.focus();
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
  secret.remove();
});

it("picks after activating a real sidebar row that then lets go of focus", async () => {
  const { screen, onToggleOption } = await renderPanel();
  await using _ = screen;
  const root = document.createElement("div");
  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.sidebarRow = "env:thread";
  row.addEventListener("click", releaseSidebarRowFocus);
  root.append(row);
  document.body.append(root);
  const dispose = installSidebarTree(root);
  row.focus();
  await userEvent.keyboard("2");
  expect(onToggleOption).not.toHaveBeenCalled();
  row.click();
  await userEvent.keyboard("2");
  expect(onToggleOption).toHaveBeenCalledWith("format", "JSON");
  dispose();
  root.remove();
});
