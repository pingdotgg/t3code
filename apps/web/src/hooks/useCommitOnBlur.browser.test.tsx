import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { DraftInput } from "../components/ui/draft-input";

describe("settings draft commits", () => {
  it("preserves an external update when an untouched field loses focus", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value={saved} onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.click();

    saved = "/projects";
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });

  it("preserves a saved edit when refocused before its server snapshot arrives", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value="~/" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.fill("/projects");
    await userEvent.tab();
    expect(saved).toBe("/projects");

    await input.click();
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });
});
