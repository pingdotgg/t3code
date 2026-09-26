import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import {
  fileOpenNotification,
  FILES_THEME_VARS,
  FILES_VIEW_COMMANDS,
  themeVarOverrides,
  watchThemeVars,
} from "./viewModel.ts";

NodeTest.describe("themeVarOverrides", () => {
  const cssVars = {
    text: "--app-theme-text",
    canvas: "--app-theme-canvas",
    mutedForeground: "--app-theme-muted-foreground",
    border: "--app-theme-border",
    muted: "--app-theme-muted",
    accentSurface: "--app-theme-accent-surface",
    messageAction: "--app-theme-message-action",
  };

  NodeTest.it("republishes contract tokens as panel-scoped vars", () => {
    NodeAssert.deepEqual(
      themeVarOverrides(
        {
          text: "#101828",
          canvas: "#ffffff",
          mutedForeground: "#98a2b3",
          border: "#eaecf0",
          muted: "#f2f4f7",
          accentSurface: "#e8eef7",
          messageAction: "#175cd3",
        },
        cssVars,
      ),
      {
        "--t3-files-text": "var(--app-theme-text, #101828)",
        "--t3-files-canvas": "var(--app-theme-canvas, #ffffff)",
        "--t3-files-muted-foreground": "var(--app-theme-muted-foreground, #98a2b3)",
        "--t3-files-border": "var(--app-theme-border, #eaecf0)",
        "--t3-files-muted": "var(--app-theme-muted, #f2f4f7)",
        "--t3-files-accent-surface": "var(--app-theme-accent-surface, #e8eef7)",
        "--t3-files-message-action": "var(--app-theme-message-action, #175cd3)",
      },
    );
  });

  NodeTest.it("skips roles the host did not resolve rather than overriding them", () => {
    NodeAssert.deepEqual(themeVarOverrides({ text: "#101828" }, cssVars), {
      "--t3-files-text": "var(--app-theme-text, #101828)",
    });
  });

  NodeTest.it("falls back to the resolved value when no css var is advertised", () => {
    NodeAssert.deepEqual(themeVarOverrides({ mutedForeground: "#98a2b3" }, {}), {
      "--t3-files-muted-foreground": "#98a2b3",
    });
  });

  NodeTest.it("ignores roles the contract does not publish to this panel", () => {
    const overrides = themeVarOverrides(
      { mutedForeground: "#98a2b3", terminalBackground: "#000000", chrome: "#111111" },
      { ...cssVars, terminalBackground: "--app-theme-terminal-background" },
    );
    NodeAssert.deepEqual(Object.keys(overrides), ["--t3-files-muted-foreground"]);
  });

  NodeTest.it("keeps FILES_THEME_VARS inside the panel's own var namespace", () => {
    for (const property of Object.values(FILES_THEME_VARS)) {
      NodeAssert.match(property, /^--t3-files-/);
    }
  });
});

NodeTest.describe("FILES_VIEW_COMMANDS", () => {
  const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;

  NodeTest.it("registers only surface-scope commands with valid ids and titles", () => {
    NodeAssert.ok(FILES_VIEW_COMMANDS.length > 0);
    const ids = new Set();
    for (const command of FILES_VIEW_COMMANDS) {
      NodeAssert.match(command.id, COMMAND_ID);
      NodeAssert.equal(command.scope, "surface");
      NodeAssert.ok(command.title.trim().length > 0);
      NodeAssert.equal("activation" in command, false);
      NodeAssert.ok(!ids.has(command.id));
      ids.add(command.id);
    }
  });

  NodeTest.it("default keys parse under the host shortcut grammar", () => {
    for (const command of FILES_VIEW_COMMANDS) {
      if (command.defaultKey === undefined) continue;
      NodeAssert.notEqual(parseKeybindingShortcut(command.defaultKey), null, command.id);
    }
  });

  NodeTest.it("default keys never collide with an unconditional native binding", () => {
    // Plugin defaults lose arbitration to every native rule, conditional or
    // not — registering a chord a native default claims unconditionally would
    // just create a permanent conflict entry. Conditional native claims (like
    // preview.refresh under previewFocus) are fine: the plugin default only
    // fills the miss while this panel is focused.
    const unconditional = new Set(
      DEFAULT_KEYBINDINGS.filter((rule) => rule.when === undefined).map((rule) => `${rule.key}`),
    );
    for (const command of FILES_VIEW_COMMANDS) {
      if (command.defaultKey === undefined) continue;
      NodeAssert.ok(
        !unconditional.has(command.defaultKey),
        `${command.id} defaults ${command.defaultKey} which a native rule already claims`,
      );
    }
  });

  NodeTest.it("default keys only claim their chord while this surface is focused", () => {
    // `extensionCommandForKeydown` returns the first registration whose
    // defaultKey matches — a `when`-less default would claim `mod+r`/`mod+f`
    // even while another extension's surface is focused, then fail surface
    // eligibility at dispatch and swallow the chord entirely.
    for (const command of FILES_VIEW_COMMANDS) {
      if (command.defaultKey === undefined) continue;
      NodeAssert.equal(
        command.when,
        "extension.t3.files/view.focus",
        `${command.id} needs the surface-focus clause so its default misses unfocused`,
      );
    }
  });
});

NodeTest.describe("fileOpenNotification", () => {
  NodeTest.it("toasts denied and unavailable failures only", () => {
    for (const status of ["idle", "resolving", "resolved"]) {
      const state =
        status === "resolved"
          ? { status, message: "opens in t3.files/view · side-panel" }
          : { status };
      NodeAssert.equal(fileOpenNotification(state, "thread-1"), null);
    }
  });

  NodeTest.it("anchors to the calling thread when the view has one", () => {
    const input = fileOpenNotification(
      { status: "denied", message: "Open is denied — missing grant" },
      "thread-1",
    );
    NodeAssert.deepEqual(input, {
      severity: "error",
      title: "Unable to open file",
      body: "Open is denied — missing grant",
      durationMs: 5_000,
      anchor: "thread",
      threadId: "thread-1",
    });
  });

  NodeTest.it("drops the thread anchor outside a thread context", () => {
    const input = fileOpenNotification(
      { status: "unavailable", message: "No provider" },
      undefined,
    );
    NodeAssert.equal(input?.severity, "error");
    NodeAssert.equal("anchor" in input, false);
    NodeAssert.equal("threadId" in input, false);
  });
});

NodeTest.describe("watchThemeVars — no stale overrides", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const viewContext = { resource: { environmentId: "env-1", threadId: "thread-1" } };

  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  }

  /** Async iterable the test drives frame-by-frame. */
  function controllableStream() {
    const queue = [];
    let waiter;
    const pump = () => {
      if (!waiter || !queue.length) return;
      const item = queue.shift();
      const { resolve, reject } = waiter;
      waiter = undefined;
      if (item.error !== undefined) reject(item.error);
      else resolve(item);
    };
    return {
      iterable: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const item = queue.shift();
              if (item !== undefined)
                return item.error !== undefined
                  ? Promise.reject(item.error)
                  : Promise.resolve(item);
              return new Promise((resolve, reject) => {
                waiter = { resolve, reject };
              });
            },
            return() {
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
      push: (frame) => (queue.push({ done: false, value: frame }), pump()),
      end: () => (queue.push({ done: true, value: undefined }), pump()),
      fail: (error) => (queue.push({ error }), pump()),
    };
  }

  function themeClient({ read, stream }) {
    return {
      invokeApi: (request) => {
        NodeAssert.equal(request.method, "getTokens");
        return read(request);
      },
      subscribeApi: (request) => {
        NodeAssert.equal(request.name, "subscribeState");
        return stream;
      },
    };
  }

  NodeTest.it("clears theme overrides when a refresh read is denied", async () => {
    const stream = controllableStream();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1
          ? Promise.resolve({ tokens: { text: "#111" }, cssVars: {} })
          : Promise.reject(new Error("grant revoked"));
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#111" }, {}));
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    stream.end();
    await done;
  });

  NodeTest.it("clears theme overrides when the state stream closes", async () => {
    const stream = controllableStream();
    const applied = [];
    const client = themeClient({
      read: () => Promise.resolve({ tokens: { text: "#111" }, cssVars: {} }),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#111" }, {}));
    stream.push({ type: "closed", value: {} });
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("clears theme overrides when the state stream errors", async () => {
    const stream = controllableStream();
    const applied = [];
    const client = themeClient({
      read: () => Promise.resolve({ tokens: { text: "#111" }, cssVars: {} }),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    stream.fail(new Error("provider gone"));
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("clears theme overrides when the state stream completes", async () => {
    const stream = controllableStream();
    const applied = [];
    const client = themeClient({
      read: () => Promise.resolve({ tokens: { text: "#111" }, cssVars: {} }),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#111" }, {}));
    stream.end();
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("a late read response cannot restore stale overrides after stream loss", async () => {
    const stream = controllableStream();
    const read = deferred();
    const applied = [];
    const client = themeClient({ read: () => read.promise, stream: stream.iterable });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    stream.push({ type: "closed", value: {} });
    await done;
    read.resolve({ tokens: { text: "#111" }, cssVars: {} });
    await tick();
    NodeAssert.ok(applied.length >= 2);
    NodeAssert.ok(applied.every((vars) => vars === null));
  });

  NodeTest.it("a failed refresh invalidates an older in-flight read", async () => {
    const stream = controllableStream();
    const stale = deferred();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1 ? stale.promise : Promise.reject(new Error("denied"));
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    // Second read (stream frame) fails while the first is still in flight;
    // the older response must not resurrect stale tokens.
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    stale.resolve({ tokens: { text: "#111" }, cssVars: {} });
    await tick();
    NodeAssert.ok(applied.every((vars) => vars === null));
    stream.end();
    await done;
  });

  NodeTest.it("an older read's late rejection does not clear a newer applied map", async () => {
    const stream = controllableStream();
    const stale = deferred();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1
          ? stale.promise
          : Promise.resolve({ tokens: { text: "#abcdef" }, cssVars: {} });
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    // The frame's read (call 2) resolves while the initial read pends, then
    // the superseded read rejects — the applied map must stand.
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#abcdef" }, {}));
    stale.reject(new Error("late denial"));
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#abcdef" }, {}));
    stream.end();
    await done;
  });
});
