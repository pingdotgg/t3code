import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { ComposerPromptEditor } from "./ComposerPromptEditor";

it("does not commit or interrupt controlled input when Enter resolves an IME composition", async () => {
  const onCommandKeyDown = vi.fn(() => true);
  const onParentKeyDown = vi.fn();

  function Harness() {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);

    return (
      <div onKeyDown={onParentKeyDown}>
        <ComposerPromptEditor
          value={value}
          cursor={cursor}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Prompt"
          onRemoveTerminalContext={vi.fn()}
          onChange={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onCommandKeyDown={onCommandKeyDown}
          onPaste={vi.fn()}
        />
      </div>
    );
  }

  const screen = await render(<Harness />);

  try {
    const editor = page.getByTestId("composer-editor");
    const element = await editor.element();
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await editor.fill("に");

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    element.dispatchEvent(enter);

    expect(onCommandKeyDown).not.toHaveBeenCalled();
    expect(onParentKeyDown).not.toHaveBeenCalled();
    await expect.element(editor).toHaveTextContent("に");

    element.dispatchEvent(new CompositionEvent("compositionend", { data: "に", bubbles: true }));
    await expect.element(editor).toHaveTextContent("に");
  } finally {
    await screen.unmount();
  }
});
