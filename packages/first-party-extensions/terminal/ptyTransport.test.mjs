/**
 * PTY byte-transport oracle — the real GhosttyTerminalSurface under a fake
 * DOM (same harness shape as perf.mjs and the repo's own surface tests)
 * drives synthetic keydown/paste/composition events through the shipped
 * event handlers. Captured `onData` bytes feed the real TerminalInputQueue
 * into a recording `write` — the same call extension.tsx binds to
 * `control.write` — so every assertion lands on the exact serialized bytes
 * that cross the wire to the PTY.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assetsDir = NodeURL.fileURLToPath(
  new URL("./", import.meta.resolve("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm")),
);

// ---------------------------------------------------------------- fake DOM
function installDom() {
  const context = {
    font: "",
    fillStyle: "",
    canvas: null,
    beginPath() {},
    clip() {},
    rect() {},
    resetTransform() {},
    restore() {},
    save() {},
    setTransform() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    measureText: (text) => ({
      width: text.length * 8,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3,
    }),
  };

  class El extends EventTarget {
    constructor() {
      super();
      this.style = {};
      this.children = [];
      this.clientWidth = 960;
      this.clientHeight = 576;
      this.width = 960;
      this.height = 576;
      this.value = "";
      this.tabIndex = 0;
      this.hidden = false;
      this.scrollTop = 0;
      this.scrollHeight = 0;
    }
    setAttribute() {}
    append(...kids) {
      for (const k of kids) k.parentElement = this;
      this.children.push(...kids);
    }
    replaceChildren(...kids) {
      this.children = [];
      this.append(...kids);
    }
    remove() {}
    select() {}
    getContext() {
      context.canvas = this;
      return context;
    }
    focus() {
      this.dispatchEvent(new Event("focus"));
    }
    blur() {
      this.dispatchEvent(new Event("blur"));
    }
    setPointerCapture() {}
    hasPointerCapture() {
      return false;
    }
    releasePointerCapture() {}
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 960, bottom: 576, width: 960, height: 576 };
    }
  }

  globalThis.document = {
    createElement: () => new El(),
    fonts: Object.assign(new EventTarget(), {
      load: async () => [],
      add() {},
      remove() {},
    }),
    hidden: false,
    execCommand: () => true,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    matchMedia: () =>
      Object.assign(new EventTarget(), {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    addEventListener() {},
    removeEventListener() {},
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { platform: "MacIntel" },
    configurable: true,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.FontFace = class {
    async load() {
      return this;
    }
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  return El;
}

const El = installDom();

const { GhosttyTerminalSurface } = await import("@t3tools/ghostty-terminal/surface");
const { loadGhosttyRuntime } = await import("@t3tools/ghostty-terminal/runtime");
const { TerminalInputQueue } = await import("./inputQueue.ts");

const THEME = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 10, g: 10, b: 12 },
  cursor: { r: 229, g: 231, b: 235 },
};

function keydown(overrides = {}) {
  return Object.assign(new Event("keydown"), {
    code: "KeyA",
    key: "a",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    getModifierState: () => false,
    ...overrides,
  });
}

async function makeRig() {
  const [vt, writePty] = await Promise.all([
    NodeFSP.readFile(new URL("ghostty-vt.wasm", `file://${assetsDir}`)),
    NodeFSP.readFile(new URL("ghostty-write-pty.wasm", `file://${assetsDir}`)),
  ]);
  const runtime = await loadGhosttyRuntime({ vt, writePty });
  // The exact byte stream the PTY would receive: onData → queue → write.
  const wireBytes = [];
  const queue = new TerminalInputQueue({
    terminalId: "term-oracle",
    write: async (data) => {
      wireBytes.push(data);
      return {};
    },
  });
  const mount = new El();
  const surface = await GhosttyTerminalSurface.create(mount, {
    runtime,
    theme: THEME,
    onData: (data) => queue.enqueue(data),
    onResize: () => {},
    onSelectionChange: () => {},
    beforeKey: () => true,
    onLinkActivate: () => {},
  });
  const drain = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = wireBytes.join("");
    wireBytes.length = 0;
    return out;
  };
  return { surface, queue, mount, drain };
}

NodeTest.describe("PTY byte-transport oracle — surface → queue → write", () => {
  NodeTest.it("keydown reaches the wire as the exact encoded sequence", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    const input = mount.children[1]; // hidden textarea
    input.dispatchEvent(keydown({ code: "KeyA", key: "a" }));
    NodeAssert.equal(await drain(), "a");
    input.dispatchEvent(keydown({ code: "Enter", key: "Enter" }));
    NodeAssert.equal(await drain(), "\r");
    input.dispatchEvent(keydown({ code: "ArrowUp", key: "ArrowUp" }));
    NodeAssert.equal(await drain(), "\x1b[A");
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("application cursor mode changes the wired arrow bytes", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    surface.write("\x1b[?1h");
    const input = mount.children[1];
    input.dispatchEvent(keydown({ code: "ArrowUp", key: "ArrowUp" }));
    NodeAssert.equal(await drain(), "\x1bOA"); // SS3, not CSI
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("kitty keyboard CSI-u reaches the wire", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    surface.write("\x1b[>1u");
    const input = mount.children[1];
    input.dispatchEvent(keydown({ code: "KeyA", key: "a", ctrlKey: true }));
    NodeAssert.match(await drain(), /\x1b\[97;5u|\x1b\[a;5/);
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("native paste events transport the bracketed payload verbatim", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    surface.write("\x1b[?2004h"); // app enabled bracketed paste
    const input = mount.children[1];
    input.dispatchEvent(
      Object.assign(new Event("paste"), {
        clipboardData: { getData: (type) => (type === "text/plain" ? "a\nb" : "") },
      }),
    );
    NodeAssert.equal(await drain(), "\x1b[200~a\nb\x1b[201~");
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("paste without mode 2004 normalizes LF to CR on the wire", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    const input = mount.children[1];
    input.dispatchEvent(
      Object.assign(new Event("paste"), {
        clipboardData: { getData: () => "a\nb" },
      }),
    );
    NodeAssert.equal(await drain(), "a\rb");
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("IME composition commits the candidate text, not keystrokes", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    const input = mount.children[1];
    // Safari's composition-opening keydown (keyCode 229) must emit nothing.
    input.dispatchEvent(keydown({ key: "Process", keyCode: 229 }));
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "界";
    input.dispatchEvent(Object.assign(new Event("compositionend"), { data: "界" }));
    NodeAssert.equal(await drain(), "界");
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("AltGr text arrives through the input event path", async () => {
    const { surface, queue, mount, drain } = await makeRig();
    const input = mount.children[1];
    input.value = "€";
    input.dispatchEvent(
      Object.assign(new Event("input"), { data: "€", isComposing: false, inputType: "insertText" }),
    );
    NodeAssert.equal(await drain(), "€");
    queue.dispose();
    surface.dispose();
  });

  NodeTest.it("queued bytes serialize through the 48KiB batch contract", async () => {
    const { surface, queue, mount } = await makeRig();
    const wireWrites = [];
    // Swap in a recording write that sees each serialized batch boundary.
    queue.dispose();
    const q2 = new TerminalInputQueue({
      terminalId: "term-oracle",
      write: async (data) => {
        wireWrites.push(data);
        return {};
      },
    });
    q2.enqueue("x".repeat(60 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.ok(wireWrites.length >= 2);
    for (const data of wireWrites) NodeAssert.ok(data.length <= 49 * 1024);
    NodeAssert.equal(wireWrites.join(""), "x".repeat(60 * 1024));
    q2.dispose();
    surface.dispose();
  });
});
