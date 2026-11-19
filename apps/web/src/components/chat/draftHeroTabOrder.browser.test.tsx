import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { moveDraftHeroRowFocus, routeDraftHeroTab } from "./draftHeroTabOrder";

function DraftHero() {
  const focusEditor = () => document.querySelector<HTMLElement>("[contenteditable]")?.focus();
  return (
    <>
      <button type="button">Header</button>
      <div
        onKeyDown={(event) => {
          if (routeDraftHeroTab(event.nativeEvent, event.currentTarget, focusEditor)) {
            event.preventDefault();
          }
        }}
      >
        <div
          role="list"
          data-draft-hero-projects=""
          onKeyDown={(event) => {
            if (moveDraftHeroRowFocus(event.nativeEvent, event.currentTarget))
              event.preventDefault();
          }}
        >
          {["alpha", "beta", "gamma"].map((name) => (
            <div role="listitem" key={name}>
              <button
                type="button"
                tabIndex={-1}
                aria-current={name === "beta" ? "true" : undefined}
              >
                {name}
              </button>
              <div>
                <button type="button" tabIndex={-1}>
                  Pin {name}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div data-chat-composer-stack="">
          <div contentEditable="true" suppressContentEditableWarning aria-label="Message" />
          <button type="button">Send</button>
        </div>
      </div>
    </>
  );
}

describe("draft hero Tab order", () => {
  it("runs message box, selected project, send, and back", async () => {
    await using screen = await render(<DraftHero />, { router: false });
    const editor = screen.getByLabelText("Message");
    const beta = screen.getByRole("button", { name: "beta", exact: true });
    await userEvent.click(editor);

    await userEvent.keyboard("{Tab}");
    await expect.element(beta).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(screen.getByRole("button", { name: "gamma", exact: true })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(beta).toHaveFocus();

    await userEvent.keyboard("{Tab}");
    await expect.element(screen.getByRole("button", { name: "Send" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(beta).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(editor).toHaveFocus();

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(screen.getByRole("button", { name: "Header" })).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(editor).toHaveFocus();
  });
});
