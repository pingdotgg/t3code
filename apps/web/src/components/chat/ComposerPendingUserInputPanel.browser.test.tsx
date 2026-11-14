import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { Select, SelectTrigger } from "../ui/select";
import { pendingQuestionKeyTarget } from "./composerFocusRedirect";
import {
  ComposerPendingUserInputPanel,
  type PendingQuestionKeyHandler,
} from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function listenForKeys(listener: (event: KeyboardEvent) => void) {
  window.addEventListener("keydown", listener, true);
  return { [Symbol.dispose]: () => window.removeEventListener("keydown", listener, true) };
}

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
    focus: "a page button while the chat column is maximized away",
    control: (
      <div data-chat-column-maximized-away="true">
        <button type="button" aria-label="Focused" />
      </div>
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
])(
  "digit shortcut with focus in $focus picks an option: $toggles",
  async ({ control, toggles }) => {
    const onOptionKey = vi.fn();
    const keyHandlerRef: { current: PendingQuestionKeyHandler | null } = { current: null };
    // Routes keys as useChatShortcuts does.
    using _listener = listenForKeys((event) => {
      const target = pendingQuestionKeyTarget(event);
      if (target !== null && keyHandlerRef.current?.(event, target)) event.preventDefault();
    });
    await using screen = await render(
      <>
        {control}
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          keyHandlerRef={keyHandlerRef}
          onToggleOption={vi.fn()}
          onOptionKey={onOptionKey}
          onRemoveOptionKey={() => false}
          onAdvance={vi.fn()}
          onConfirm={vi.fn()}
          onDismiss={vi.fn()}
        />
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    screen.getByLabelText("Focused").element().focus();

    await userEvent.keyboard("1");

    expect(onOptionKey.mock.calls).toEqual(toggles ? [["question", "1"]] : []);
  },
);
