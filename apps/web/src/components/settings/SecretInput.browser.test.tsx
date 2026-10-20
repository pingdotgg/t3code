import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretInput } from "./SecretInput";

const input = (screen: Screen) => screen.container.querySelector("input")!;

async function edit(screen: Screen, value: string) {
  await userEvent.clear(input(screen));
  if (value) await userEvent.type(input(screen), value);
  await userEvent.click(document.body);
}

describe("SecretInput", () => {
  it("preserves a configured secret on empty edits and commits a replacement", async () => {
    const onCommit = vi.fn();
    await using screen = await render(<SecretInput configured value="" onCommit={onCommit} />);
    expect(input(screen).type).toBe("password");

    await userEvent.click(input(screen));
    await userEvent.click(document.body);
    expect(onCommit).not.toHaveBeenCalled();

    await edit(screen, "replacement");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
    expect(input(screen).value).toBe("");
  });

  it("allows clearing an unsaved draft", async () => {
    const onCommit = vi.fn();
    await using screen = await render(<SecretInput value="draft" onCommit={onCommit} />);
    await edit(screen, "");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps an in-progress replacement when settings refresh", async () => {
    const onCommit = vi.fn();
    const ui = () => <SecretInput configured value="" onCommit={onCommit} />;
    await using screen = await render(ui());

    await userEvent.type(input(screen), "replacement");
    await screen.rerender(ui());
    expect(input(screen).value).toBe("replacement");

    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
  });
});
