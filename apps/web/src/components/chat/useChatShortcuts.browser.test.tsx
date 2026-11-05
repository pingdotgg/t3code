import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { type KeyboardEventHandler, useEffect, useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { render } from "../../../test/render";
import type { ShortcutMatchContext } from "../../keybindings";
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
function Chat(props: { composerKeys: string[]; launcher?: { keys: string; received: string[] } }) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
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
    commands: {},
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

const escapeStops: ResolvedKeybindingsConfig = [
  {
    command: "thread.stop",
    shortcut: {
      key: "escape",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  },
];

function StoppableChat(props: {
  stops: string[];
  keybindings?: ResolvedKeybindingsConfig;
  closedFinds?: string[];
  onWidgetKeyDown?: KeyboardEventHandler;
  canStop?: boolean;
  context?: Partial<ShortcutMatchContext>;
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: props.keybindings ?? escapeStops,
    scriptKeybindings: [],
    getShortcutContext: () => ({ ...shortcutContext, ...props.context }),
    threadFindActive: props.closedFinds !== undefined,
    composerRef: { current: null },
    branchToolbarRef: { current: null },
    closeThreadFind: () => void props.closedFinds?.push("find"),
    commands: {
      "thread.stop": () => {
        if (props.canStop === false) return false;
        props.stops.push("stop");
      },
    },
    fallback: () => undefined,
  });
  return (
    <div ref={focusOnMount} tabIndex={0} aria-label="Widget" onKeyDown={props.onWidgetKeyDown} />
  );
}

it("stops the turn once on an Escape nothing claimed", async () => {
  const stops: string[] = [];
  await using _screen = await render(<StoppableChat stops={stops} />, options);

  await userEvent.keyboard("{Escape}");

  expect(stops).toEqual(["stop"]);
});

it.each([
  { claim: "preventDefault", onWidgetKeyDown: (event) => event.preventDefault() },
  { claim: "stopPropagation", onWidgetKeyDown: (event) => event.stopPropagation() },
] satisfies { claim: string; onWidgetKeyDown: KeyboardEventHandler }[])(
  "leaves the turn running when a widget claims Escape with $claim",
  async ({ onWidgetKeyDown }) => {
    const stops: string[] = [];
    await using _screen = await render(
      <StoppableChat stops={stops} onWidgetKeyDown={onWidgetKeyDown} />,
      options,
    );

    await userEvent.keyboard("{Escape}");

    expect(stops).toEqual([]);
  },
);

// ProseMirror calls preventDefault on every Escape; the composer claims one by stopping it too.
it.each([
  {
    name: "stops on the Escape the editor only prevented",
    stopPropagation: false,
    stops: ["stop"],
  },
  { name: "leaves the Escape the composer claimed", stopPropagation: true, stops: [] },
])("$name", async ({ stopPropagation, stops: expected }) => {
  const stops: string[] = [];
  await using _screen = await render(
    <StoppableChat
      stops={stops}
      context={{ composerFocus: true, editableFocus: true }}
      onWidgetKeyDown={(event) => {
        event.preventDefault();
        if (stopPropagation) event.stopPropagation();
      }}
    />,
    options,
  );

  await userEvent.keyboard("{Escape}");

  expect(stops).toEqual(expected);
});

it.each([
  { name: "a terminal", context: { terminalFocus: true } },
  { name: "a preview", context: { previewFocus: true } },
  { name: "the model picker", context: { modelPickerOpen: true } },
  { name: "another text field", context: { editableFocus: true } },
])("leaves Escape to $name even with no when clause", async ({ context }) => {
  const stops: string[] = [];
  await using _screen = await render(<StoppableChat stops={stops} context={context} />, options);

  await userEvent.keyboard("{Escape}");

  expect(stops).toEqual([]);
});

it("closes thread find before Escape can stop the turn", async () => {
  const stops: string[] = [];
  const closedFinds: string[] = [];
  await using _screen = await render(
    <StoppableChat stops={stops} closedFinds={closedFinds} />,
    options,
  );

  await userEvent.keyboard("{Escape}");

  expect(closedFinds).toEqual(["find"]);
  expect(stops).toEqual([]);
});

it("does not claim Escape when there is nothing to stop", async () => {
  await using _screen = await render(<StoppableChat stops={[]} canStop={false} />, options);

  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(escape);

  expect(escape.defaultPrevented).toBe(false);
});

it("still runs a chord bound to thread.stop ahead of the focused widget", async () => {
  const stops: string[] = [];
  await using _screen = await render(
    <StoppableChat
      stops={stops}
      keybindings={[ctrlShift("x", "thread.stop")]}
      onWidgetKeyDown={(event) => event.stopPropagation()}
    />,
    options,
  );

  await userEvent.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");

  expect(stops).toEqual(["stop"]);
});
