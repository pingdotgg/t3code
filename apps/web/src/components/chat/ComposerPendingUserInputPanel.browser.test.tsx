import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
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

const noteQuestion = {
  id: "database",
  header: "Database",
  question: "Use Postgres?",
  options: [
    { label: "Yes", description: "Yes" },
    { label: "No", description: "No" },
  ],
  multiSelect: false,
  supportsNote: true,
};

function NoteHarness(props: {
  readonly initial?: Record<string, PendingUserInputDraftAnswer>;
  readonly onAdvance: () => void;
  readonly onFocusComposer?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>(
    props.initial ?? {},
  );
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[{ ...prompt, questions: [noteQuestion] }]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={0}
      onToggleOption={(questionId, optionValue) =>
        setAnswers((current) => ({
          ...current,
          [questionId]: togglePendingUserInputOptionSelection(
            noteQuestion,
            current[questionId],
            optionValue,
          ),
        }))
      }
      onAdvance={props.onAdvance}
      onDismiss={vi.fn()}
      {...(props.onFocusComposer ? { onFocusComposer: props.onFocusComposer } : {})}
    />
  );
}

function buttonElement(locator: { element: () => Element }) {
  const element = locator.element();
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button");
  return element;
}

it("a second tap that clears a single pick on a question that takes notes does not advance", async () => {
  const onAdvance = vi.fn();
  await using screen = await render(
    <NoteHarness initial={{ database: { customAnswer: "on a new host" } }} onAdvance={onAdvance} />,
  );
  const option = screen.getByRole("button", { name: /^Yes/ });
  await expect.element(option).toBeVisible();
  const button = buttonElement(option);
  using _timers = fakeTimers();
  button.click();
  await expect.element(option).toHaveAttribute("aria-pressed", "true");
  button.click();
  await expect.element(option).toHaveAttribute("aria-pressed", "false");
  vi.advanceTimersByTime(1_000);

  expect(onAdvance).not.toHaveBeenCalled();
});

it("the note button picks an option without sending and opens the composer", async () => {
  const onAdvance = vi.fn();
  const onFocusComposer = vi.fn();
  await using screen = await render(
    <NoteHarness onAdvance={onAdvance} onFocusComposer={onFocusComposer} />,
  );
  const yes = screen.getByRole("button", { name: /^Yes/ });
  const no = screen.getByRole("button", { name: /^No/ });
  await expect.element(yes).toBeVisible();
  using _timers = fakeTimers();
  buttonElement(screen.getByRole("button", { name: "Add a note to Yes" })).click();
  await expect.element(yes).toHaveAttribute("aria-pressed", "true");
  // While a note is being added, changing the pick waits for Enter too.
  buttonElement(no).click();
  await expect.element(no).toHaveAttribute("aria-pressed", "true");
  vi.advanceTimersByTime(1_000);

  expect(onFocusComposer).toHaveBeenCalledOnce();
  expect(onAdvance).not.toHaveBeenCalled();
});
