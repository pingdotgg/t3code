import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

vi.mock(import("~/hooks/useSettings"), () => ({
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, typingWithSelection: "cite" }),
}));

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

const focusOnMount = (element: HTMLElement | null) => element?.focus();

// Stands in for the right panel's launcher, which needs the whole app around it. Like the
// real one it takes focus, advertises its letters in `data-surface-launcher-keys`, and
// claims one from its own window capture listener unless the key was already handled.
function Launcher(props: { keys: string; received: string[] }) {
  useEffect(() => {
    const claim = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = surfaceShortcutKey(event);
      if (key === null || !props.keys.toLowerCase().includes(key)) return;
      event.preventDefault();
      props.received.push(event.key);
    };
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [props.keys, props.received]);
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={props.keys}
    />
  );
}

// The chat's shortcut listener registers when the chat mounts, so a launcher that opens
// later registers after it. Tests mount the chat first and add the launcher by rerendering.
function Chat(props: {
  composerKeys: string[];
  launcher?: { keys: string; received: string[] };
  stops?: string[];
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: [
      {
        command: "thread.stop",
        shortcut: {
          key: "a",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      },
    ],
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    // Type-to-focus only calls insertTextAtEnd, so the stand-in composer implements just that.
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: { "thread.stop": () => void props.stops?.push("stop") },
    fallback: () => undefined,
  });
  return props.launcher ? <Launcher {...props.launcher} /> : null;
}

// router: false because the chat shortcuts and the launcher stand-in never navigate.
const options = { router: false } as const;

it("leaves the launcher's letters to the launcher, in either case", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("tT");

  expect(received).toEqual(["t", "T"]);
  expect(composerKeys).toEqual([]);
});

it("still types other letters into the composer while the launcher is open", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("a");

  expect(composerKeys).toEqual(["a"]);
  expect(received).toEqual([]);
});

it("leaves a non-Latin launcher letter to the launcher by its physical key", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  // Playwright cannot press a key its US layout lacks, so send what a Ukrainian T key sends.
  const event = new KeyboardEvent("keydown", {
    key: "\u0435",
    code: "KeyT",
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);

  expect(composerKeys).toEqual([]);
  expect(received).toEqual(["\u0435"]);
});

it.each([
  { key: "b", code: "KeyN", composer: [], launcher: ["b"] },
  { key: "x", code: "KeyB", composer: ["x"], launcher: [] },
  { key: "è", code: "KeyT", composer: ["è"], launcher: [] },
])("routes $key on $code by the typed letter", async ({ key, code, composer, launcher }) => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);

  expect(composerKeys).toEqual(composer);
  expect(received).toEqual(launcher);
});

const ctrlShift = (key: string, command: KeybindingCommand) => ({
  command,
  shortcut: { key, metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, modKey: false },
});
const sideChatKeybindings: ResolvedKeybindingsConfig = [
  ctrlShift("m", "modelPicker.toggle"),
  ctrlShift("x", "thread.stop"),
];

// A side chat in the main chat's panel: no window listeners, only its composer's own chords.
function SideChat(props: { toggles: string[]; stops: string[] }) {
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  useChatShortcuts({
    enabled: false,
    embedded: true,
    composerElement,
    keybindings: sideChatKeybindings,
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    composerRef: {
      current: {
        toggleModelPicker: () => props.toggles.push("model"),
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: { "thread.stop": () => void props.stops.push("stop") },
    fallback: () => undefined,
  });
  return (
    <>
      <div ref={setComposerElement}>
        <textarea aria-label="Side chat composer" />
      </div>
      <textarea aria-label="Main composer" />
    </>
  );
}

it("runs a side chat's composer chords only from its composer, and never thread commands", async () => {
  const toggles: string[] = [];
  const stops: string[] = [];
  await using screen = await render(<SideChat toggles={toggles} stops={stops} />, options);

  await userEvent.click(screen.getByLabelText("Side chat composer"));
  await userEvent.keyboard("{Control>}{Shift>}MX{/Shift}{/Control}");
  await userEvent.click(screen.getByLabelText("Main composer"));
  await userEvent.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");

  expect(toggles).toEqual(["model"]);
  expect(stops).toEqual([]);
});

it("does not resolve a shortcut after citation input consumes its key", async () => {
  const composerKeys: string[] = [];
  const stops: string[] = [];
  await using _screen = await render(<Chat composerKeys={composerKeys} stops={stops} />, options);
  const toolbar = document.createElement("button");
  toolbar.dataset.typeToCite = "true";
  toolbar.addEventListener("cite-selection-input", (event) => event.preventDefault());
  document.body.append(toolbar);
  using _toolbar = { [Symbol.dispose]: () => toolbar.remove() };
  const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(stops).toEqual([]);
  expect(composerKeys).toEqual([]);
});
