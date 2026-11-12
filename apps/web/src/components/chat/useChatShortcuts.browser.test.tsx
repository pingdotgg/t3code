import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

function ScrollChat(props: {
  onEnd: () => void;
  composerKeys?: string[];
  embedded?: boolean;
  context?: Record<string, boolean>;
  keybindings?: ResolvedKeybindingsConfig;
}) {
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  useChatShortcuts({
    enabled: true,
    embedded: props.embedded === true,
    messageAreaRef,
    composerElement,
    keybindings: props.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: (target) => ({
      ...shortcutContext,
      messageAreaFocus: document.activeElement === messageAreaRef.current,
      composerFocus:
        target instanceof Element && target.getAttribute("aria-label") === "Chat input",
      ...props.context,
    }),
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys?.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: { "chat.scrollToEnd": props.onEnd },
    fallback: () => undefined,
  });
  return (
    <div data-side-chat-pane={props.embedded ? "true" : undefined}>
      <div ref={messageAreaRef} tabIndex={0} aria-label="Messages">
        <button>Message action</button>
      </div>
      <div ref={setComposerElement}>
        <textarea aria-label="Chat input" />
      </div>
      <textarea aria-label="Other editor" defaultValue={"first line\nsecond line"} />
    </div>
  );
}

it.each([
  { embedded: false, key: "ctrl+end", keyboard: "{Control>}{End}{/Control}", defaults: true },
  { embedded: true, key: "ctrl+end", keyboard: "{Control>}{End}{/Control}", defaults: true },
  { embedded: false, key: "end", keyboard: "{End}", defaults: false },
  { embedded: true, key: "end", keyboard: "{End}", defaults: false },
  { embedded: false, key: "g", keyboard: "g", defaults: false },
  { embedded: true, key: "g", keyboard: "g", defaults: false },
])(
  "routes $key in main/embedded chat ($embedded) and reads the current thread callback",
  async ({ embedded, key, keyboard, defaults }) => {
    const calls: string[] = [];
    const composerKeys: string[] = [];
    const keybindings = defaults
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : compileResolvedKeybindingsConfig([
          { key, command: "chat.scrollToEnd", when: "messageAreaFocus || composerFocus" },
        ]);
    await using screen = await render(
      <ScrollChat
        embedded={embedded}
        composerKeys={composerKeys}
        keybindings={keybindings}
        onEnd={() => {
          calls.push("first");
        }}
      />,
      options,
    );
    screen.getByLabelText("Messages").element().focus();
    await userEvent.keyboard(keyboard);
    await screen.rerender(
      <ScrollChat
        embedded={embedded}
        composerKeys={composerKeys}
        keybindings={keybindings}
        onEnd={() => {
          calls.push("second");
        }}
      />,
    );
    await userEvent.click(screen.getByLabelText("Chat input"));
    if (defaults) {
      await userEvent.type(screen.getByLabelText("Chat input"), "first line\nsecond line");
      await userEvent.keyboard("{Control>}{Home}{/Control}{End}");
      expect(calls).toEqual(["first"]);
      expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(10);
    }
    await userEvent.keyboard(keyboard);
    await userEvent.click(screen.getByRole("button", { name: "Message action" }));
    await userEvent.keyboard("{End}");
    await userEvent.click(screen.getByLabelText("Other editor"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{End}");
    expect(calls).toEqual(["first", "second"]);
    expect(composerKeys).toEqual([]);
    expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(10);
  },
);

it.each([{ terminalFocus: true }, { previewFocus: true }, { modelPickerOpen: true }])(
  "keeps unconditioned custom shortcuts out of excluded controls: %j",
  async (context) => {
    const calls: string[] = [];
    await using screen = await render(
      <ScrollChat
        context={context}
        onEnd={() => {
          calls.push("end");
        }}
        keybindings={compileResolvedKeybindingsConfig([
          { key: "end", command: "chat.scrollToEnd" },
        ])}
      />,
      options,
    );
    await userEvent.click(screen.getByLabelText("Chat input"));
    await userEvent.keyboard("{End}");
    expect(calls).toEqual([]);
  },
);

it("preserves custom precedence and leaves dialogs alone", async () => {
  const calls: string[] = [];
  const custom = compileResolvedKeybindingsConfig([
    { key: "end", command: "chat.scrollToEnd" },
    { key: "end", command: "thread.stop" },
  ]);
  await using screen = await render(
    <ScrollChat
      onEnd={() => {
        calls.push("end");
      }}
      keybindings={custom}
    />,
    options,
  );
  await userEvent.click(screen.getByLabelText("Chat input"));
  await userEvent.keyboard("{End}");
  expect(calls).toEqual([]);
  await screen.rerender(
    <>
      <ScrollChat
        onEnd={() => {
          calls.push("end");
        }}
      />
      <div role="dialog" aria-modal="true">
        Dialog
      </div>
    </>,
  );
  await userEvent.click(screen.getByLabelText("Chat input"));
  await userEvent.keyboard("{End}");
  expect(calls).toEqual([]);
});
