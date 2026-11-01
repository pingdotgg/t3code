import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

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

const ctrl = (key: string, command: KeybindingCommand, shiftKey = false) => ({
  command,
  shortcut: { key, metaKey: false, ctrlKey: true, shiftKey, altKey: false, modKey: false },
});

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
  finds?: string[];
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: [ctrl("f", "chat.find")],
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
    commands: { "chat.find": () => void props.finds?.push("main") },
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

const sideChatKeybindings: ResolvedKeybindingsConfig = [
  ctrl("m", "modelPicker.toggle", true),
  ctrl("x", "thread.stop", true),
  // The default find rule, with ctrl for mod so it matches on every platform.
  ...compileResolvedKeybindingsConfig([
    { key: "ctrl+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  ]),
];

// A side chat in the main chat's right panel: no window listeners, only its pane's find and its
// composer's own chords. Passing `findCloses` opens its find.
function SideChat(props: {
  toggles: string[];
  stops: string[];
  finds?: string[];
  findCloses?: string[];
}) {
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  useChatShortcuts({
    enabled: false,
    embedded: true,
    composerElement,
    keybindings: sideChatKeybindings,
    scriptKeybindings: [],
    getShortcutContext: () => ({ ...shortcutContext, previewFocus: isPreviewFocused() }),
    threadFindActive: props.findCloses !== undefined,
    composerRef: {
      current: {
        toggleModelPicker: () => props.toggles.push("model"),
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => void props.findCloses?.push("side"),
    commands: {
      "thread.stop": () => void props.stops.push("stop"),
      "chat.find": () => void props.finds?.push("side"),
    },
    fallback: () => undefined,
  });
  return (
    <>
      <div data-preview-panel-mode="inline">
        <div data-side-chat-pane>
          <input aria-label="Side chat find" />
          <div tabIndex={0} aria-label="Side chat timeline">
            Conversation
          </div>
          <div ref={setComposerElement}>
            <textarea aria-label="Side chat composer" />
          </div>
        </div>
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

it("opens the side chat's own find for mod+F anywhere in its pane, not the main chat's", async () => {
  const finds: string[] = [];
  await using screen = await render(
    <>
      <Chat composerKeys={[]} finds={finds} />
      <SideChat toggles={[]} stops={[]} finds={finds} />
    </>,
    options,
  );

  await userEvent.click(screen.getByLabelText("Side chat composer"));
  await userEvent.keyboard("{Control>}f{/Control}");
  await userEvent.click(screen.getByLabelText("Side chat timeline"));
  await userEvent.keyboard("{Control>}f{/Control}");

  expect(finds).toEqual(["side", "side"]);
});

it("closes the side chat's find for Escape in its find input and elsewhere in its pane", async () => {
  const findCloses: string[] = [];
  await using screen = await render(
    <SideChat toggles={[]} stops={[]} findCloses={findCloses} />,
    options,
  );
  // Stands in for the narrow right panel sheet, which also closes on an Escape that reaches it.
  const sheetEscapes: string[] = [];
  const onSheetKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") sheetEscapes.push("sheet");
  };
  document.addEventListener("keydown", onSheetKeyDown);
  using _sheet = {
    [Symbol.dispose]: () => document.removeEventListener("keydown", onSheetKeyDown),
  };

  await userEvent.click(screen.getByLabelText("Side chat find"));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByLabelText("Side chat timeline"));
  await userEvent.keyboard("{Escape}");

  expect(findCloses).toEqual(["side", "side"]);
  expect(sheetEscapes).toEqual([]);
});
