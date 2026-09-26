import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { resolveShortcutCommand } from "../keybindings";
import {
  getTerminalFocusOwner,
  isExtensionClaimedTerminalCommand,
  isExtensionDockTerminalFocused,
  isTerminalFocused,
} from "./terminalFocus";

class MockHTMLElement {
  isConnected = false;
  className = "";
  terminalOwner: string | null = null;
  readonly dataset: { terminalOwner?: string; terminalPlacement?: string } = {};

  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  };

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) {
      return null;
    }
    if (selector === "[data-terminal-owner]" && this.terminalOwner !== null) {
      return this;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isTerminalFocused", () => {
  it("returns false for detached xterm helper textareas", () => {
    const detached = new MockHTMLElement();
    detached.className = "xterm-helper-textarea";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: detached } as unknown as Document;

    expect(isTerminalFocused()).toBe(false);
  });

  it("returns the drawer owner for connected xterm helper textareas", () => {
    const attached = new MockHTMLElement();
    attached.className = "xterm-helper-textarea";
    attached.isConnected = true;
    attached.terminalOwner = "drawer";
    attached.dataset.terminalOwner = "drawer";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: attached } as unknown as Document;

    expect(getTerminalFocusOwner()).toBe("drawer");
    expect(isTerminalFocused()).toBe(true);
  });

  it("returns the right panel owner for focus inside its terminal UI", () => {
    const sidebarButton = new MockHTMLElement();
    sidebarButton.className = "terminal-sidebar-button";
    sidebarButton.isConnected = true;
    sidebarButton.terminalOwner = "right-panel";
    sidebarButton.dataset.terminalOwner = "right-panel";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: sidebarButton } as unknown as Document;

    expect(getTerminalFocusOwner()).toBe("right-panel");
    expect(isTerminalFocused()).toBe(true);
  });

  it("returns the extension owner for focus inside a declared terminal surface", () => {
    const pluginInput = new MockHTMLElement();
    pluginInput.isConnected = true;
    pluginInput.terminalOwner = "extension";
    pluginInput.dataset.terminalOwner = "extension";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: pluginInput } as unknown as Document;

    expect(getTerminalFocusOwner()).toBe("extension");
    expect(isTerminalFocused()).toBe(true);
  });

  it("rejects owner values the host did not write", () => {
    const forged = new MockHTMLElement();
    forged.isConnected = true;
    forged.terminalOwner = "plugin-terminal";
    forged.dataset.terminalOwner = "plugin-terminal";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: forged } as unknown as Document;

    expect(getTerminalFocusOwner()).toBeNull();
    expect(isTerminalFocused()).toBe(false);
  });
});

describe("isExtensionClaimedTerminalCommand", () => {
  it.each(["terminal.split", "terminal.splitVertical", "terminal.new", "terminal.close"])(
    "claims %s while an extension surface owns focus",
    (command) => {
      expect(isExtensionClaimedTerminalCommand(command, "extension")).toBe(true);
    },
  );

  it.each(["terminal.split", "terminal.splitVertical", "terminal.new", "terminal.close"])(
    "leaves %s to the native dispatcher for native owners",
    (command) => {
      expect(isExtensionClaimedTerminalCommand(command, "drawer")).toBe(false);
      expect(isExtensionClaimedTerminalCommand(command, "right-panel")).toBe(false);
      expect(isExtensionClaimedTerminalCommand(command, null)).toBe(false);
    },
  );

  it.each(["terminal.toggle", "rightPanel.close", "thread.pin", "diff.toggle"])(
    "does not claim %s, which is not focused-terminal scoped",
    (command) => {
      expect(isExtensionClaimedTerminalCommand(command, "extension")).toBe(false);
    },
  );
});

function focusTerminalFrame(owner: string, placement?: string) {
  const element = new MockHTMLElement();
  element.isConnected = true;
  element.terminalOwner = owner;
  element.dataset.terminalOwner = owner;
  if (placement !== undefined) element.dataset.terminalPlacement = placement;
  globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
  globalThis.document = { activeElement: element } as unknown as Document;
}

describe("mod+n inside a claiming extension terminal", () => {
  const modN = {
    key: "n",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  const resolveModN = () =>
    resolveShortcutCommand(modN, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
      context: { terminalFocus: isTerminalFocused() },
    });

  it("resolves to the terminal command the surface owns, not the new-thread picker", () => {
    focusTerminalFrame("extension", "side-panel");
    const command = resolveModN();
    expect(command).toBe("terminal.new");
    expect(isExtensionClaimedTerminalCommand(command!, getTerminalFocusOwner())).toBe(true);
  });

  it("still opens a new thread when focus is outside every terminal", () => {
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: null } as unknown as Document;
    expect(resolveModN()).toBe("chat.new");
  });
});

describe("isExtensionDockTerminalFocused", () => {
  it("is true for a claiming extension surface in the extension dock", () => {
    focusTerminalFrame("extension", "bottom-dock");
    expect(isExtensionDockTerminalFocused()).toBe(true);
  });

  it("leaves the toggle to the native drawer from a side-panel extension terminal", () => {
    focusTerminalFrame("extension", "side-panel");
    expect(isExtensionDockTerminalFocused()).toBe(false);
  });

  it("leaves the toggle to the native drawer from native terminals", () => {
    focusTerminalFrame("drawer", "bottom-dock");
    expect(isExtensionDockTerminalFocused()).toBe(false);
    focusTerminalFrame("right-panel");
    expect(isExtensionDockTerminalFocused()).toBe(false);
  });
});
