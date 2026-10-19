import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { SecretInput } from "./SecretInput";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector("input")!;

async function edit(value: string) {
  await userEvent.clear(input());
  if (value) await userEvent.type(input(), value);
  await userEvent.click(document.body);
}

describe("SecretInput", () => {
  it("preserves a configured secret on empty edits and commits a replacement", async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<SecretInput configured value="" onCommit={onCommit} />));
    expect(input().type).toBe("password");

    await userEvent.click(input());
    await userEvent.click(document.body);
    expect(onCommit).not.toHaveBeenCalled();

    await edit("replacement");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
    expect(input().value).toBe("");
  });

  it("allows clearing an unsaved draft", async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<SecretInput value="draft" onCommit={onCommit} />));
    await edit("");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps an in-progress replacement when settings refresh", async () => {
    const onCommit = vi.fn();
    const render = () => root.render(<SecretInput configured value="" onCommit={onCommit} />);
    await act(async () => render());

    await userEvent.type(input(), "replacement");
    await act(async () => render());
    expect(input().value).toBe("replacement");

    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
  });
});
