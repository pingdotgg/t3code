import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { Select, SelectTrigger } from "../ui/select";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-shortcuts"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question",
      header: "Rollout",
      question: "How should this ship?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: true,
    },
  ],
};

function panel(onToggleOption: (questionId: string, optionValue: string) => void) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={vi.fn()}
      onDismiss={vi.fn()}
    />
  );
}

it.each<{ focus: string; control: ReactNode; toggles: boolean }>([
  { focus: "a page button", control: <button type="button" aria-label="Focused" />, toggles: true },
  {
    focus: "a dialog",
    control: (
      <div role="dialog">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a popup",
    control: (
      <div data-slot="menu-popup">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a menu",
    control: (
      <div role="menu">
        <button type="button" role="menuitem" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a select",
    control: (
      <select aria-label="Focused">
        <option>One</option>
      </select>
    ),
    toggles: false,
  },
  {
    focus: "a closed select menu",
    control: (
      <Select>
        <SelectTrigger aria-label="Focused" />
      </Select>
    ),
    toggles: false,
  },
  {
    focus: "a device screen that takes the key",
    control: (
      <div
        role="application"
        aria-label="Focused"
        tabIndex={0}
        onKeyDown={(event) => event.preventDefault()}
      />
    ),
    toggles: false,
  },
])(
  "digit shortcut with focus in $focus toggles an option: $toggles",
  async ({ control, toggles }) => {
    const onToggleOption = vi.fn();
    await using screen = await render(
      <>
        {control}
        {panel(onToggleOption)}
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    screen.getByLabelText("Focused").element().focus();

    await userEvent.keyboard("1");

    expect(onToggleOption.mock.calls).toEqual(toggles ? [["question", "Incremental"]] : []);
  },
);

it.each<{ focus: string; html: string; nested?: boolean; typed: string; toggles: boolean }>([
  {
    focus: "a file editor",
    html: '<div data-focus contenteditable="true"></div>',
    typed: "1",
    toggles: false,
  },
  { focus: "a find bar", html: "<input data-focus />", nested: true, typed: "1", toggles: false },
  { focus: "a button", html: "<button data-focus></button>", typed: "", toggles: true },
])(
  "digit shortcut with focus in $focus inside a shadow root toggles an option: $toggles",
  async ({ html, nested, typed, toggles }) => {
    const onToggleOption = vi.fn();
    await using screen = await render(
      <>
        <div data-testid="shadow-host" />
        {panel(onToggleOption)}
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    let root = screen.getByTestId("shadow-host").element().attachShadow({ mode: "open" });
    if (nested)
      root = root.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
    root.innerHTML = html;
    const focused = root.querySelector<HTMLElement>("[data-focus]")!;
    focused.focus();

    await userEvent.keyboard("1");

    expect(onToggleOption.mock.calls).toEqual(toggles ? [["question", "Incremental"]] : []);
    expect("value" in focused ? focused.value : focused.textContent).toBe(typed);
  },
);
