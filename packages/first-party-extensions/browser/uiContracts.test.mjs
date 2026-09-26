import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import { uiNotificationsApi, uiPanelsApi, uiThemeApi } from "@t3tools/extension-sdk/catalogue";
import {
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";

import {
  BROWSER_GLOBAL_COMMANDS,
  BROWSER_SURFACE_ID,
  BROWSER_VIEW_COMMANDS,
  focusAddressInput,
  notifyToggleFailure,
  themeVarOverrides,
  togglePanelSurface,
  watchThemeVars,
} from "./uiContracts.ts";

const context = {
  client: "web",
  resource: {
    namespace: "t3.browser",
    id: BROWSER_SURFACE_ID,
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
};

/** A `bindApi`-compatible client that records invocations and answers per method. */
function fakeClient(answers, calls) {
  return {
    invokeApi: async (request) => {
      calls.push(request);
      const answer = answers[request.method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer(request);
      return answer;
    },
  };
}

/** Flushes queued microtasks across the stream→invoke→apply hop chain. */
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

/** A manually driven `subscribeApi` iterable — push frames, close, or fail. */
function controllableStream() {
  const queued = [];
  const waiters = [];
  let ended = false;
  let failure = null;
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length > 0) return Promise.resolve(queued.shift());
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
      };
    },
  };
  const settleWaiter = (entry) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(entry);
    else queued.push(entry);
  };
  return {
    iterable,
    push: (frame) => settleWaiter({ value: frame, done: false }),
    close() {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ done: true, value: undefined });
      else ended = true;
    },
    fail(error) {
      const waiter = waiters.shift();
      if (waiter) waiter.reject(error);
      else failure = error;
    },
  };
}

/** Bound `t3.ui/theme` api whose `getTokens` consumes `reads` in order. */
function fakeTheme(reads) {
  return bindApi(
    uiThemeApi,
    fakeClient(
      {
        getTokens: () => {
          const read = reads.shift();
          if (read instanceof Error) throw read;
          return read;
        },
      },
      [],
    ),
    context,
  );
}

function fakeThemeStreams(stream) {
  return bindStreamApi(uiThemeApi, { subscribeApi: () => stream.iterable }, context);
}

NodeTest.describe("themeVarOverrides", () => {
  const cssVars = {
    text: "--app-theme-text",
    mutedForeground: "--app-theme-muted-foreground",
    border: "--app-theme-border",
    canvas: "--app-theme-canvas",
  };

  NodeTest.it("republishes contract tokens as panel-scoped vars", () => {
    const overrides = themeVarOverrides(
      { text: "#101828", mutedForeground: "#98a2b3", border: "#eaecf0", canvas: "#ffffff" },
      cssVars,
    );
    NodeAssert.deepEqual(overrides, {
      "--t3-browser-text": "var(--app-theme-text, #101828)",
      "--t3-browser-muted-foreground": "var(--app-theme-muted-foreground, #98a2b3)",
      "--t3-browser-border": "var(--app-theme-border, #eaecf0)",
      "--t3-browser-canvas": "var(--app-theme-canvas, #ffffff)",
    });
  });

  NodeTest.it("skips roles the host did not resolve rather than overriding them", () => {
    NodeAssert.deepEqual(themeVarOverrides({ text: "#101828" }, cssVars), {
      "--t3-browser-text": "var(--app-theme-text, #101828)",
    });
  });

  NodeTest.it("falls back to the resolved value when no css var is advertised", () => {
    NodeAssert.deepEqual(themeVarOverrides({ mutedForeground: "#98a2b3" }, {}), {
      "--t3-browser-muted-foreground": "#98a2b3",
    });
  });

  NodeTest.it("ignores roles outside the panel's consumed set", () => {
    const overrides = themeVarOverrides(
      { mutedForeground: "#98a2b3", terminalBackground: "#000000", error: "#f04438" },
      { ...cssVars, terminalBackground: "--app-theme-terminal-background" },
    );
    NodeAssert.deepEqual(Object.keys(overrides), ["--t3-browser-muted-foreground"]);
  });
});

NodeTest.describe("command descriptors", () => {
  NodeTest.it("view commands are surface-scoped, focus-gated, and parse", () => {
    NodeAssert.equal(BROWSER_VIEW_COMMANDS.length, 2);
    for (const command of BROWSER_VIEW_COMMANDS) {
      NodeAssert.equal(command.scope, "surface");
      NodeAssert.equal(command.when, `extension.${BROWSER_SURFACE_ID}.focus`);
      NodeAssert.notEqual(parseKeybindingWhenExpression(command.when), null);
      NodeAssert.notEqual(parseKeybindingShortcut(command.defaultKey), null);
    }
    NodeAssert.deepEqual(
      BROWSER_VIEW_COMMANDS.map((command) => command.id),
      ["reload", "focusAddress"],
    );
  });

  NodeTest.it("the global toggle names its own surface for activation", () => {
    NodeAssert.equal(BROWSER_GLOBAL_COMMANDS.length, 1);
    const [toggle] = BROWSER_GLOBAL_COMMANDS;
    NodeAssert.equal(toggle.id, "toggle");
    NodeAssert.equal(toggle.scope, "global");
    NodeAssert.deepEqual(toggle.activation, {
      surfaceId: BROWSER_SURFACE_ID,
      placement: "side-panel",
    });
    NodeAssert.notEqual(parseKeybindingShortcut(toggle.defaultKey), null);
  });
});

NodeTest.describe("togglePanelSurface", () => {
  NodeTest.it("opens the surface when none is listed", async () => {
    const calls = [];
    const panels = bindApi(
      uiPanelsApi,
      fakeClient(
        { listSurfaces: { surfaces: [] }, openSurface: { surfaceId: BROWSER_SURFACE_ID } },
        calls,
      ),
      context,
    );
    NodeAssert.equal(
      await togglePanelSurface(panels, "thread", new AbortController().signal),
      "opened",
    );
    NodeAssert.deepEqual(
      calls.map((call) => call.method),
      ["listSurfaces", "openSurface"],
    );
    NodeAssert.deepEqual(calls[1].input, {
      surfaceId: BROWSER_SURFACE_ID,
      placement: "side-panel",
      threadId: "thread",
    });
  });

  NodeTest.it("activates a present but inactive surface", async () => {
    const calls = [];
    const panels = bindApi(
      uiPanelsApi,
      fakeClient(
        {
          listSurfaces: {
            surfaces: [
              { id: BROWSER_SURFACE_ID, title: "Browser", placement: "side-panel", active: false },
            ],
          },
          activateSurface: { applied: true },
        },
        calls,
      ),
      context,
    );
    NodeAssert.equal(
      await togglePanelSurface(panels, "thread", new AbortController().signal),
      "activated",
    );
    NodeAssert.deepEqual(
      calls.map((call) => call.method),
      ["listSurfaces", "activateSurface"],
    );
  });

  NodeTest.it("closes the surface when it is active", async () => {
    const calls = [];
    const panels = bindApi(
      uiPanelsApi,
      fakeClient(
        {
          listSurfaces: {
            surfaces: [
              { id: BROWSER_SURFACE_ID, title: "Browser", placement: "side-panel", active: true },
            ],
          },
          closeSurface: { applied: true },
        },
        calls,
      ),
      context,
    );
    NodeAssert.equal(
      await togglePanelSurface(panels, "thread", new AbortController().signal),
      "closed",
    );
    NodeAssert.deepEqual(
      calls.map((call) => call.method),
      ["listSurfaces", "closeSurface"],
    );
  });

  NodeTest.it("ignores other installations' surfaces in the listing", async () => {
    const calls = [];
    const panels = bindApi(
      uiPanelsApi,
      fakeClient(
        {
          listSurfaces: {
            surfaces: [
              { id: "t3.other/view", title: "Other", placement: "side-panel", active: true },
            ],
          },
          openSurface: { surfaceId: BROWSER_SURFACE_ID },
        },
        calls,
      ),
      context,
    );
    NodeAssert.equal(
      await togglePanelSurface(panels, "thread", new AbortController().signal),
      "opened",
    );
  });
});

NodeTest.describe("notifyToggleFailure", () => {
  NodeTest.it("posts a thread-anchored error toast with the failure detail", async () => {
    const calls = [];
    const notifications = bindApi(
      uiNotificationsApi,
      fakeClient({ notify: { notificationId: "ntf-1" } }, calls),
      context,
    );
    await notifyToggleFailure(
      notifications,
      "thread",
      new Error("Surface is not open"),
      new AbortController().signal,
    );
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0].method, "notify");
    NodeAssert.deepEqual(calls[0].input, {
      severity: "error",
      title: "Unable to toggle the browser panel",
      body: "Surface is not open",
      threadId: "thread",
      anchor: "thread",
    });
  });

  NodeTest.it("omits the body for non-Error failures", async () => {
    const calls = [];
    const notifications = bindApi(
      uiNotificationsApi,
      fakeClient({ notify: { notificationId: "ntf-1" } }, calls),
      context,
    );
    await notifyToggleFailure(notifications, "thread", "denied", new AbortController().signal);
    NodeAssert.equal(calls[0].input.body, undefined);
  });
});

NodeTest.describe("watchThemeVars", () => {
  const themeResult = {
    tokens: { text: "#101828" },
    cssVars: { text: "--app-theme-text" },
  };
  const themeVars = { "--t3-browser-text": "var(--app-theme-text, #101828)" };
  const frame = (sequence = 1) => ({
    type: "data",
    value: {},
    streamId: "stream",
    sequence,
  });

  NodeTest.it("publishes resolved tokens on start", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    watchThemeVars(fakeTheme([themeResult]), fakeThemeStreams(stream), controller.signal, (vars) =>
      applied.push(vars),
    );
    await settle();
    NodeAssert.deepEqual(applied, [themeVars]);
    controller.abort();
  });

  NodeTest.it("clears the applied map when a refresh rejects — no stale fallback", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    watchThemeVars(
      fakeTheme([themeResult, new Error("grant revoked")]),
      fakeThemeStreams(stream),
      controller.signal,
      (vars) => applied.push(vars),
    );
    await settle();
    NodeAssert.deepEqual(applied, [themeVars]);
    stream.push(frame());
    await settle();
    NodeAssert.deepEqual(applied, [themeVars, null]);
    controller.abort();
  });

  NodeTest.it("republishes fresh tokens on a live frame after a cleared failure", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    watchThemeVars(
      fakeTheme([new Error("denied"), themeResult]),
      fakeThemeStreams(stream),
      controller.signal,
      (vars) => applied.push(vars),
    );
    await settle();
    NodeAssert.deepEqual(applied, [null]);
    stream.push(frame());
    await settle();
    NodeAssert.deepEqual(applied, [null, themeVars]);
    controller.abort();
  });

  NodeTest.it("a closed stream clears the map and fences a read still in flight", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    let resolveRead;
    const pending = new Promise((resolve) => {
      resolveRead = resolve;
    });
    watchThemeVars(fakeTheme([pending]), fakeThemeStreams(stream), controller.signal, (vars) =>
      applied.push(vars),
    );
    await settle();
    stream.close();
    await settle();
    NodeAssert.deepEqual(applied, [null]);
    // The obsolete read must not republish after its subscription is gone.
    resolveRead(themeResult);
    await settle();
    NodeAssert.deepEqual(applied, [null]);
    controller.abort();
  });

  NodeTest.it("a failed stream clears the last applied map", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    watchThemeVars(fakeTheme([themeResult]), fakeThemeStreams(stream), controller.signal, (vars) =>
      applied.push(vars),
    );
    await settle();
    NodeAssert.deepEqual(applied, [themeVars]);
    stream.fail(new Error("connection lost"));
    await settle();
    NodeAssert.deepEqual(applied, [themeVars, null]);
    controller.abort();
  });

  NodeTest.it("applies nothing after the watcher's signal aborts", async () => {
    const stream = controllableStream();
    const applied = [];
    const controller = new AbortController();
    watchThemeVars(fakeTheme([themeResult]), fakeThemeStreams(stream), controller.signal, (vars) =>
      applied.push(vars),
    );
    controller.abort();
    stream.close();
    await settle();
    NodeAssert.deepEqual(applied, []);
  });
});

NodeTest.describe("focusAddressInput", () => {
  NodeTest.it("focuses then selects so typing replaces the address", () => {
    const calls = [];
    focusAddressInput({
      focus: () => calls.push("focus"),
      select: () => calls.push("select"),
    });
    NodeAssert.deepEqual(calls, ["focus", "select"]);
  });

  NodeTest.it("is a no-op without a mounted input", () => {
    focusAddressInput(null);
  });
});
