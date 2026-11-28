import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  ThreadId,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  isMacPlatform,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { RegistryProvider } from "@effect/atom-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ShortcutMatchContext } from "../../keybindings";
import { render } from "../../../test/render";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import { ChatShortcutContext } from "./chatShortcutContext";
import { useChatShortcuts } from "./useChatShortcuts";

type OnCite = ComponentProps<typeof AssistantSelectionToolbar>["onCite"];

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

const customKeybindings = (rules: KeybindingRule[]) =>
  mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(rules));

// The chat's window capture listener runs before the toolbar's document listener, so
// type-to-focus sees every key first. The stand-in composer records what it receives.
function ChatShortcuts(props: {
  composerKeys: string[];
  keybindings: ResolvedKeybindingsConfig;
  shortcutContext?: Partial<ShortcutMatchContext>;
  onPalette?: () => void;
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: props.keybindings,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
      ...props.shortcutContext,
    }),
    threadFindActive: false,
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
    commands: props.onPalette ? { "commandPalette.toggle": () => props.onPalette!() } : {},
    fallback: () => undefined,
  });
  return null;
}

function Transcript(props: {
  onCite: OnCite;
  composerKeys?: string[];
  keybindings?: ResolvedKeybindingsConfig;
  shortcutContext?: Partial<ShortcutMatchContext>;
  onPalette?: () => void;
  text?: string;
  children?: ReactNode;
}) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const keybindings = props.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const chatShortcutContext = props.shortcutContext
    ? {
        hintContext: props.shortcutContext,
        getShortcutContext: () => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
          ...props.shortcutContext,
        }),
      }
    : null;
  return (
    <RegistryProvider initialValues={[[primaryServerKeybindingsAtom, keybindings]]}>
      {props.composerKeys ? (
        <ChatShortcuts
          composerKeys={props.composerKeys}
          keybindings={keybindings}
          {...(props.shortcutContext ? { shortcutContext: props.shortcutContext } : {})}
          {...(props.onPalette ? { onPalette: props.onPalette } : {})}
        />
      ) : null}
      {props.children}
      <div ref={setViewport}>
        <div data-assistant-citation-source="message-1">
          <p>{props.text ?? "Render the citation chip"}</p>
        </div>
      </div>
      <ChatShortcutContext value={chatShortcutContext}>
        <AssistantSelectionToolbar
          viewport={viewport}
          threadRef={threadRef}
          onCite={props.onCite}
        />
      </ChatShortcutContext>
    </RegistryProvider>
  );
}

// router: false because the transcript never navigates.
const options = { router: false } as const;
const citeButton = page.getByRole("button", { name: "Cite selection in composer" });

function selectText(container: HTMLElement, start: number, end: number) {
  const text = container.querySelector("p")!.firstChild!;
  window.getSelection()!.setBaseAndExtent(text, start, text, end);
}

async function selectAssistantText(container: HTMLElement) {
  selectText(container, 7, 15);
  await expect.element(citeButton).toBeVisible();
}

// Dispatched rather than typed so the key lands before the toolbar's scheduled refresh, and so a
// real browser chord (Ctrl+R) cannot reload the test page.
function pressKey(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe("AssistantSelectionToolbar", () => {
  it.each(["r", "R"])("cites with %s instead of typing it into the composer", async (key) => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );
    await selectAssistantText(screen.container);
    await expect.element(citeButton).toHaveAttribute("aria-keyshortcuts", "R");

    await userEvent.keyboard(key);

    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.lastCall![0]).toMatchObject({ messageId: "message-1", text: "the cita" });
    expect(composerKeys).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(true);
    await expect.element(citeButton).not.toBeInTheDocument();
  });

  it("types R into the composer when nothing is selected", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using _screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );

    await userEvent.keyboard("r");

    expect(composerKeys).toEqual(["r"]);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("follows a remapped shortcut and leaves R to the composer", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    const mac = isMacPlatform(navigator.platform);
    await using screen = await render(
      <Transcript
        onCite={onCite}
        composerKeys={composerKeys}
        keybindings={customKeybindings([{ key: "mod+l", command: "chat.citeSelection" }])}
      />,
      options,
    );
    await selectAssistantText(screen.container);
    await expect.element(citeButton.getByText(mac ? "⌘L" : "Ctrl+L")).toBeVisible();
    await expect
      .element(citeButton)
      .toHaveAttribute("aria-keyshortcuts", mac ? "Meta+L" : "Control+L");

    await userEvent.keyboard("r");
    expect(composerKeys).toEqual(["r"]);
    expect(onCite).not.toHaveBeenCalled();

    const event = pressKey("l", mac ? { metaKey: true } : { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.lastCall![0]).toMatchObject({ text: "the cita" });
  });

  it("hides the hint and leaves R to the composer once unassigned", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript
        onCite={onCite}
        composerKeys={composerKeys}
        keybindings={customKeybindings([
          { key: "r", command: "chat.citeSelection", when: "false" },
        ])}
      />,
      options,
    );
    await selectAssistantText(screen.container);
    await expect.element(citeButton).not.toHaveAttribute("aria-keyshortcuts");
    expect(citeButton.element().querySelector("kbd")).toBeNull();

    await userEvent.keyboard("r");

    expect(composerKeys).toEqual(["r"]);
    expect(onCite).not.toHaveBeenCalled();
  });

  // Neither default nor unconditional custom rules (bare or modifier) may take keys from a focused field.
  it.each([
    ["input", DEFAULT_RESOLVED_KEYBINDINGS, "r", {}],
    ["textarea", customKeybindings([{ key: "r", command: "chat.citeSelection" }]), "r", {}],
    [
      "input (mod+l)",
      customKeybindings([{ key: "mod+l", command: "chat.citeSelection" }]),
      "l",
      isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true },
    ],
  ] as const)(
    "leaves the cite shortcut to a focused %s while assistant text is selected",
    async (field, keybindings, key, modifiers) => {
      const onCite = vi.fn<OnCite>(() => true);
      await using screen = await render(
        <Transcript onCite={onCite} keybindings={keybindings}>
          {field.startsWith("input") ? (
            <input aria-label="Field" />
          ) : (
            <textarea aria-label="Field" />
          )}
        </Transcript>,
        options,
      );
      // Focused without a click, which would dismiss the toolbar before the selection exists.
      screen.container.querySelector<HTMLElement>("input, textarea")!.focus();
      await selectAssistantText(screen.container);
      await expect.element(page.getByRole("textbox", { name: "Field" })).toHaveFocus();

      const event = pressKey(key, modifiers);

      expect(event.defaultPrevented).toBe(false);
      expect(onCite).not.toHaveBeenCalled();
    },
  );

  it("evaluates custom when conditions against the chat shortcut context", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const onPalette = vi.fn();
    const mac = isMacPlatform(navigator.platform);
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript
        onCite={onCite}
        onPalette={onPalette}
        composerKeys={composerKeys}
        shortcutContext={{ terminalOpen: true }}
        keybindings={customKeybindings([
          { key: "mod+l", command: "chat.citeSelection", when: "terminalOpen" },
          { key: "mod+k", command: "chat.citeSelection", when: "!terminalOpen" },
        ])}
      />,
      options,
    );
    await selectAssistantText(screen.container);
    await expect.element(citeButton.getByText(mac ? "⌘L" : "Ctrl+L")).toBeVisible();

    pressKey("k", mod);
    expect(onPalette).toHaveBeenCalledOnce();
    expect(onCite).not.toHaveBeenCalled();

    pressKey("l", mod);
    expect(onCite).toHaveBeenCalledOnce();
  });

  it("moves outside the response or grows past the limit before R without dropping the key", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    const longText = `Render the citation chip ${"x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 20)}`;
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} text={longText}>
        <div data-testid="outside">Outside response text</div>
      </Transcript>,
      options,
    );
    await selectAssistantText(screen.container);

    const outsideText = screen.container.querySelector('[data-testid="outside"]')!.firstChild!;
    window.getSelection()!.setBaseAndExtent(outsideText, 0, outsideText, 7);
    pressKey("r");
    expect(onCite).not.toHaveBeenCalled();
    expect(composerKeys).toEqual(["r"]);

    await selectAssistantText(screen.container);
    selectText(screen.container, 0, longText.length);
    pressKey("r");
    expect(onCite).not.toHaveBeenCalled();
    expect(composerKeys).toEqual(["r", "r"]);
  });

  it("cites immediately when a too-long selection is shrunk under the limit before refresh", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    const longText = `Render the citation chip ${"x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 20)}`;
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} text={longText} />,
      options,
    );
    selectText(screen.container, 0, longText.length);
    await expect
      .element(page.getByRole("button", { name: "Selection is too long to cite" }))
      .toBeVisible();

    selectText(screen.container, 7, 15);
    const event = pressKey("r");

    expect(event.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.lastCall![0]).toMatchObject({ text: "the cita" });
    expect(composerKeys).toEqual([]);
  });

  it("activates citation when remapped to Tab instead of only focusing Cite", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(
      <Transcript
        onCite={onCite}
        keybindings={customKeybindings([{ key: "tab", command: "chat.citeSelection" }])}
      />,
      options,
    );
    await selectAssistantText(screen.container);
    await expect.element(citeButton).toHaveAttribute("aria-keyshortcuts", "Tab");

    await userEvent.keyboard("{Tab}");

    expect(onCite).toHaveBeenCalledOnce();
  });

  it("does not swallow repeated printable keys when the toolbar ignores auto-repeat", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );
    await selectAssistantText(screen.container);

    pressKey("r", { repeat: true });

    expect(onCite).not.toHaveBeenCalled();
    expect(composerKeys).toEqual(["r"]);
  });

  it.each([
    ["extended", 19, "the citation"],
    ["shrunk", 10, "the"],
  ])("cites a selection %s just before R", async (_change, end, text) => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );
    await selectAssistantText(screen.container);

    selectText(screen.container, 7, end);
    const event = pressKey("r");

    expect(event.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.lastCall![0]).toMatchObject({ text });
    expect(composerKeys).toEqual([]);
  });

  it("does not cite a selection collapsed just before R", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );
    await selectAssistantText(screen.container);

    window.getSelection()!.collapseToEnd();
    pressKey("r");

    expect(onCite).not.toHaveBeenCalled();
    expect(composerKeys).toEqual(["r"]);
    await expect.element(citeButton).not.toBeInTheDocument();
  });

  it.each([
    ["Cmd+R", { metaKey: true }],
    ["Ctrl+R", { ctrlKey: true }],
    ["Alt+R", { altKey: true }],
  ])("leaves %s to the browser", async (_name, modifier) => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);

    const event = pressKey("r", modifier);

    expect(event.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("still focuses the Cite action on Tab", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);

    await userEvent.keyboard("{Tab}");

    await expect.element(citeButton).toHaveFocus();
    expect(onCite).not.toHaveBeenCalled();
  });
});
