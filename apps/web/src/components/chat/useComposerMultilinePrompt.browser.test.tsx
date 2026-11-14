import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";

function Composer({ text }: { readonly text: string }) {
  const [multiline, observeBody] = useComposerMultilinePrompt();
  return (
    <div ref={observeBody} style={{ width: 200, lineHeight: "20px" }}>
      <div data-testid="composer-editor" contentEditable suppressContentEditableWarning>
        {text}
      </div>
      <output>{multiline ? "multiline" : "single line"}</output>
    </div>
  );
}

it("notices when typing makes the prompt wrap", async () => {
  await using screen = await render(<Composer text="short" />, { router: false });
  await expect.element(screen.getByText("single line")).toBeVisible();
  await screen.rerender(<Composer text={"a long prompt that wraps ".repeat(6)} />);
  await expect.element(screen.getByText("multiline")).toBeVisible();
});
