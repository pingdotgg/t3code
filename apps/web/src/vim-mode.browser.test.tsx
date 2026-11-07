import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../test/render";
import { startVimMode } from "./vim-mode";

const settings = vi.hoisted(() => ({ vimModeEnabled: true }));
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock("./hooks/useSettings", () => ({
  getClientSettings: () => settings,
  subscribeClientSettings: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => [
      {
        command: "thread.next",
        shortcut: {
          key: "]",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ],
  },
}));
vi.mock("./state/server", () => ({ primaryServerKeybindingsAtom: {} }));

function setup(vimModeEnabled: boolean) {
  settings.vimModeEnabled = vimModeEnabled;
  listeners.clear();
}

function useVimMode() {
  setup(true);
  const stop = startVimMode();
  return {
    [Symbol.dispose]() {
      settings.vimModeEnabled = false;
      for (const listener of listeners) listener();
      stop();
    },
  };
}

function Field({ initial, onSubmit }: { initial: string; onSubmit?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <textarea
        aria-label="field"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <output aria-label="state">{value}</output>
      <button type="button" onClick={() => setValue("")}>
        clear
      </button>
    </form>
  );
}

async function focusField(screen: { getByLabelText(text: string): unknown }) {
  await userEvent.click(screen.getByLabelText("field") as never);
  // The adapter loads on first focus, and it starts in insert mode.
  await vi.waitFor(async () => {
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("[data-vim-mode-label]")).not.toBeNull();
  });
}

function textOf() {
  return document.querySelector("output")?.textContent;
}

describe("textareas", () => {
  it("edits a React-controlled textarea", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="one two three" />);
    await focusField(screen);
    await userEvent.keyboard("0wdw");
    expect(textOf()).toBe("one three");
    await userEvent.keyboard("u");
    expect(textOf()).toBe("one two three");
  });

  it("undoes a typed insert as one step", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="a" />);
    await focusField(screen);
    await userEvent.keyboard("A one two{Escape}u");
    expect(textOf()).toBe("a");
  });

  it("keeps Mod+Z as undo and redo while typing", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="a" />);
    await focusField(screen);
    await userEvent.keyboard("Ab");
    expect(textOf()).toBe("ab");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(textOf()).toBe("a");
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(textOf()).toBe("ab");
    await userEvent.keyboard("c");
    expect(textOf()).toBe("abc");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(textOf()).toBe("ab");
  });

  it("undoes with Mod+Z from visual mode instead of changing case", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="AB" />);
    await focusField(screen);
    await userEvent.keyboard("0xv{Control>}z{/Control}");
    expect(textOf()).toBe("AB");
    expect(document.querySelector("[data-vim-mode-label]")?.textContent).toBe("NORMAL");
  });

  it("undoes each native paste in normal mode on its own", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="abc" />);
    await focusField(screen);
    const paste = (data: string) =>
      document.querySelector("textarea")?.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          data,
          bubbles: true,
          cancelable: true,
        }),
      );
    await userEvent.keyboard("0x");
    paste("X");
    paste("Y");
    const pasted = textOf();
    expect(pasted).toHaveLength(4);
    await userEvent.keyboard("u");
    expect(textOf()).toHaveLength(3);
    await userEvent.keyboard("u");
    expect(textOf()).toBe("bc");
  });

  it("blocks typing in normal mode and shows the mode", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="hello" />);
    await focusField(screen);
    expect(document.querySelector("[data-vim-mode-label]")?.textContent).toBe("NORMAL");
    await userEvent.keyboard("zQ");
    expect(textOf()).toBe("hello");
  });

  it("never edits on Enter in normal mode", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="hello" />);
    await focusField(screen);
    await userEvent.keyboard("{Enter}");
    expect(textOf()).toBe("hello");
  });

  it("keeps Escape from reaching the page while leaving insert mode", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="hello" />);
    await focusField(screen);
    await userEvent.keyboard("i");
    const reachedPage = vi.fn();
    document.addEventListener("keydown", reachedPage);
    await userEvent.keyboard("{Escape}");
    document.removeEventListener("keydown", reachedPage);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it("returns to insert when the form clears it", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="hello" />);
    await focusField(screen);
    (document.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(textOf()).toBe(""));
    await userEvent.click(screen.getByLabelText("field"));
    await userEvent.keyboard("hi");
    expect(textOf()).toBe("hi");
  });

  it("leaves terminal-style hidden inputs alone", async () => {
    using _vim = useVimMode();
    await using screen = await render(<textarea aria-label="sink" data-vim-ignore="" />);
    await userEvent.click(screen.getByLabelText("sink"));
    await userEvent.keyboard("{Escape}dd");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("dd");
  });

  it("stops when the setting turns off", async () => {
    using _vim = useVimMode();
    await using screen = await render(<Field initial="hello" />);
    await focusField(screen);
    settings.vimModeEnabled = false;
    for (const listener of listeners) listener();
    await userEvent.keyboard("x");
    expect(document.querySelector("[data-vim-mode-label]")).toBeNull();
  });
});

function Pane() {
  return (
    <main style={{ height: 100, overflowY: "auto" }} data-testid="pane">
      <div style={{ height: 2000 }} />
    </main>
  );
}

describe("navigation", () => {
  it.each([
    ["j", 60],
    ["d", 50],
    ["G", 1900],
  ])("%s scrolls the pane", async (key, top) => {
    using _vim = useVimMode();
    await using _screen = await render(<Pane />);
    await userEvent.keyboard(key);
    await vi.waitFor(() => expect(document.querySelector("main")?.scrollTop).toBeCloseTo(top, -1));
  });

  it("returns to the top with gg", async () => {
    using _vim = useVimMode();
    await using _screen = await render(<Pane />);
    await userEvent.keyboard("Ggg");
    await vi.waitFor(() => expect(document.querySelector("main")?.scrollTop).toBe(0));
  });

  it("runs a command through the user's own shortcut", async () => {
    using _vim = useVimMode();
    await using _screen = await render(<Pane />);
    const seen: KeyboardEvent[] = [];
    const record = (event: KeyboardEvent) => seen.push(event);
    window.addEventListener("keydown", record);
    await userEvent.keyboard("J");
    window.removeEventListener("keydown", record);
    const synthetic = seen.find((event) => !event.isTrusted);
    expect(synthetic?.key).toBe("]");
    expect(synthetic?.metaKey || synthetic?.ctrlKey).toBe(true);
  });

  it("moves through a focused list with arrows", async () => {
    using _vim = useVimMode();
    const onKeyDown = vi.fn();
    await using screen = await render(
      <ul role="listbox" onKeyDown={(event) => onKeyDown(event.key)}>
        <li role="option" aria-selected tabIndex={0}>
          one
        </li>
      </ul>,
    );
    (screen.container.querySelector("li") as HTMLElement).focus();
    await userEvent.keyboard("j");
    expect(onKeyDown).toHaveBeenCalledWith("ArrowDown");
  });

  it("leaves editable fields to them", async () => {
    using _vim = useVimMode();
    await using screen = await render(<input aria-label="search" />);
    await userEvent.click(screen.getByLabelText("search"));
    await userEvent.keyboard("jk");
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("jk");
  });

  it("does nothing with the setting off", async () => {
    setup(false);
    await using _screen = await render(<Pane />);
    await userEvent.keyboard("j");
    expect(document.querySelector("main")?.scrollTop).toBe(0);
  });
});
