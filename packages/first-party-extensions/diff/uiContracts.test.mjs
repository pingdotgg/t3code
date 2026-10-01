import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  DIFF_SURFACE_ID,
  DIFF_TOGGLE_COMMAND_ID,
  DIFF_TOGGLE_GLOBAL_COMMANDS,
  DIFF_TOGGLE_VIEW_COMMANDS,
  bindDiffViewCommands,
  diffToggleAction,
  panelTheme,
  stageDiffCommands,
  themeVar,
  toggleDiffSurface,
  watchThemeTokens,
} from "./uiContracts.ts";

const CONTEXT = {
  resource: {
    namespace: "t3.threads",
    id: "thread-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
  },
  client: "web",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ALL_PANEL_OPS = {
  listSurfaces: true,
  openSurface: true,
  activateSurface: true,
  closeSurface: true,
  hideDock: true,
  showDock: true,
};

/**
 * A ClientHost stub recording invokeApi calls; subscribeApi defaults to an
 * ended stream. `t3.ui/panels` getCapabilities answers all-ops-true unless
 * `panelOps` overrides individual flags or is `false` (probe falls through
 * to the custom invoke, e.g. to reject).
 */
const fakeHost = ({ invoke, subscribe, panelOps } = {}) => {
  const calls = [];
  const capabilities = {
    adapter: "fake",
    operations: { ...ALL_PANEL_OPS, ...panelOps },
    clients: [],
  };
  return {
    calls,
    host: {
      invokeApi(request, _signal) {
        calls.push(request);
        if (
          request.id === "t3.ui/panels" &&
          request.method === "getCapabilities" &&
          panelOps !== false
        )
          return Promise.resolve(capabilities);
        return Promise.resolve(invoke ? invoke(request) : {});
      },
      subscribeApi(_request, signal) {
        return (
          subscribe?.(_request, signal) ?? {
            async *[Symbol.asyncIterator]() {},
          }
        );
      },
    },
  };
};

const streamOf = (frames) => ({
  async *[Symbol.asyncIterator]() {
    for (const frame of frames) {
      yield frame;
    }
  },
});

/** A manually driven async iterable: push frames, end, or fail on demand. */
const manualStream = () => {
  const END = Symbol("end");
  const queue = [];
  const waiters = [];
  const deliver = (item) => {
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else queue.push(item);
  };
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const item = queue.length
          ? queue.shift()
          : await new Promise((resolve) => waiters.push(resolve));
        if (item === END) return;
        if (item instanceof Error) throw item;
        yield item;
      }
    },
  };
  return {
    iterable,
    push: (frame) => deliver(frame),
    end: () => deliver(END),
    fail: (error) => deliver(error),
  };
};

/** A deferred promise for controlling invokeApi resolution order. */
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

NodeTest.test("themeVar falls back to the static value without tokens", () => {
  NodeAssert.equal(themeVar(null, "--border", "border", "#dfe3e8"), "var(--border, #dfe3e8)");
  NodeAssert.equal(
    themeVar({ border: "#123456" }, "--border", "border", "#dfe3e8"),
    "var(--border, #123456)",
  );
  NodeAssert.equal(
    themeVar({ other: "#123456" }, "--border", "border", "#dfe3e8"),
    "var(--border, #dfe3e8)",
  );
});

NodeTest.test("panelTheme maps host roles to the panel's css variables", () => {
  const tokens = {
    mutedForeground: "#m",
    border: "#b",
    accentSurface: "#a",
    error: "#e",
    canvas: "#c",
    text: "#t",
    muted: "#ms",
  };
  const ui = panelTheme(tokens);
  NodeAssert.equal(ui.muted, "var(--muted-foreground, #m)");
  NodeAssert.equal(ui.border, "var(--border, #b)");
  NodeAssert.equal(ui.accent, "var(--accent, #a)");
  NodeAssert.equal(ui.destructive, "var(--destructive, #e)");
  NodeAssert.equal(ui.background, "var(--background, #c)");
  NodeAssert.equal(ui.foreground, "var(--foreground, #t)");
  NodeAssert.equal(ui.mutedSurface, "var(--muted, #ms)");
  NodeAssert.equal(ui.control.border, "1px solid var(--border, #b)");
  NodeAssert.equal(ui.gutter.color, "var(--muted-foreground, #m)");

  const fallback = panelTheme(null);
  NodeAssert.equal(fallback.border, "var(--border, #dfe3e8)");
  NodeAssert.equal(fallback.control.border, "1px solid var(--border, #dfe3e8)");
});

NodeTest.test("diffToggleAction mirrors the native toggle over listSurfaces", () => {
  const surface = (active) => ({
    id: DIFF_SURFACE_ID,
    title: "Diff",
    placement: "side-panel",
    active,
  });
  NodeAssert.equal(diffToggleAction([]), "open");
  NodeAssert.equal(diffToggleAction([surface(false)]), "activate");
  NodeAssert.equal(diffToggleAction([surface(true)]), "close");
  NodeAssert.equal(
    diffToggleAction([{ id: "other/view", title: "X", placement: "side-panel", active: true }]),
    "open",
  );
});

NodeTest.test("toggleDiffSurface opens, activates, or closes via t3.ui/panels", async () => {
  for (const [surfaces, method] of [
    [[], "openSurface"],
    [
      [{ id: DIFF_SURFACE_ID, title: "Diff", placement: "side-panel", active: false }],
      "activateSurface",
    ],
    [
      [{ id: DIFF_SURFACE_ID, title: "Diff", placement: "side-panel", active: true }],
      "closeSurface",
    ],
  ]) {
    const { host, calls } = fakeHost({
      invoke: (request) =>
        request.method === "listSurfaces"
          ? { surfaces }
          : { applied: true, surfaceId: DIFF_SURFACE_ID },
    });
    const action = await toggleDiffSurface(host, CONTEXT);
    NodeAssert.equal(calls[0].method, "getCapabilities");
    NodeAssert.equal(calls[1].method, "listSurfaces");
    NodeAssert.deepEqual(calls[1].input, { threadId: "thread-1" });
    NodeAssert.equal(calls[2].method, method);
    NodeAssert.equal(calls[2].input.surfaceId, DIFF_SURFACE_ID);
    NodeAssert.equal(calls[2].input.threadId, "thread-1");
    if (method === "openSurface") NodeAssert.equal(calls[2].input.placement, "side-panel");
    NodeAssert.equal(
      action,
      method === "openSurface" ? "open" : method === "activateSurface" ? "activate" : "close",
    );
  }
});

NodeTest.test("toggleDiffSurface returns null without a thread scope", async () => {
  const { host, calls } = fakeHost();
  const context = {
    ...CONTEXT,
    resource: { namespace: "t3.extensions", id: "t3.diff", environmentId: "env-1" },
  };
  NodeAssert.equal(await toggleDiffSurface(host, context), null);
  NodeAssert.equal(calls.length, 0);
});

NodeTest.test("stageDiffCommands stages the native-equivalent global toggle", async () => {
  const { host } = fakeHost();
  // A host without the seam: staging is a no-op, not a crash.
  NodeAssert.doesNotThrow(() => stageDiffCommands(host));

  const { host: seamHost, calls } = fakeHost({
    invoke: (request) =>
      request.method === "listSurfaces"
        ? {
            surfaces: [
              { id: DIFF_SURFACE_ID, title: "Diff", placement: "side-panel", active: true },
            ],
          }
        : { applied: true },
  });
  let staged;
  seamHost.registerGlobalCommands = (commands, handler) => {
    staged = { commands, handler };
    return { status: "staged", onDidChange: () => () => {} };
  };
  stageDiffCommands(seamHost);
  NodeAssert.equal(staged.commands, DIFF_TOGGLE_GLOBAL_COMMANDS);
  const descriptor = staged.commands[0];
  NodeAssert.equal(descriptor.id, "toggle");
  NodeAssert.equal(descriptor.defaultKey, "mod+d");
  NodeAssert.equal(descriptor.when, "!terminalFocus");
  NodeAssert.equal(descriptor.scope, "global");
  NodeAssert.deepEqual(descriptor.activation, {
    surfaceId: DIFF_SURFACE_ID,
    placement: "side-panel",
  });

  // Dispatch drives the panels toggle; unknown ids are ignored.
  staged.handler({ commandId: "other", context: CONTEXT });
  staged.handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
  await flush();
  NodeAssert.deepEqual(
    calls.map((call) => call.method),
    ["getCapabilities", "listSurfaces", "closeSurface"],
  );
});

NodeTest.test("toggleDiffSurface reports unavailable when panels ops are missing", async () => {
  const { host, calls } = fakeHost({ panelOps: { openSurface: false } });
  NodeAssert.equal(await toggleDiffSurface(host, CONTEXT), "unavailable");
  NodeAssert.deepEqual(
    calls.map((call) => call.method),
    ["getCapabilities"],
  );
});

NodeTest.test("toggleDiffSurface maps a denied panels grant to unavailable", async () => {
  // The broker's live grant check rejects every op even while the provider
  // stays reachable — a revoked t3.ui/panels is access loss, not op failure.
  const { host } = fakeHost({
    invoke: (request) =>
      request.id === "t3.ui/panels"
        ? Promise.reject(new Error("API capability denied: t3.ui/panels"))
        : {},
  });
  NodeAssert.equal(await toggleDiffSurface(host, CONTEXT), "unavailable");
});

NodeTest.test("toggle dispatch failures surface via t3.ui/notifications", async () => {
  const { host, calls } = fakeHost({
    invoke: (request) =>
      request.id === "t3.ui/panels"
        ? Promise.reject(new Error("grant revoked"))
        : { notificationId: "n-1" },
  });
  let staged;
  host.registerGlobalCommands = (commands, handler) => {
    staged = { commands, handler };
    return { status: "staged", onDidChange: () => () => {} };
  };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    stageDiffCommands(host);
    staged.handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
    await flush();
  } finally {
    console.warn = original;
  }
  const notify = calls.find(
    (call) => call.id === "t3.ui/notifications" && call.method === "notify",
  );
  NodeAssert.ok(notify);
  NodeAssert.equal(notify.input.severity, "error");
  NodeAssert.equal(notify.input.threadId, "thread-1");
  NodeAssert.equal(notify.input.anchor, "thread");
  NodeAssert.equal(warnings.length, 0);
});

NodeTest.test(
  "toggle dispatch failures fall back to console when notify is unavailable",
  async () => {
    const { host } = fakeHost({
      invoke: () => Promise.reject(new Error("everything down")),
    });
    let staged;
    host.registerGlobalCommands = (commands, handler) => {
      staged = { commands, handler };
      return { status: "staged", onDidChange: () => () => {} };
    };
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      stageDiffCommands(host);
      staged.handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
      await flush();
    } finally {
      console.warn = original;
    }
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.equal(warnings[0][0], "t3.diff/toggle dispatch failed:");
  },
);

NodeTest.test("a global dispatch against missing panels access withdraws the command", async () => {
  const { host, calls } = fakeHost({
    panelOps: { closeSurface: false },
    invoke: (request) =>
      request.id === "t3.ui/notifications" ? { notificationId: "n-1" } : { unregistered: true },
  });
  let staged;
  host.registerGlobalCommands = (commands, handler) => {
    staged = { commands, handler };
    return { status: "active", token: "global-tok", onDidChange: () => () => {} };
  };
  stageDiffCommands(host);
  staged.handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
  await flush();
  const notify = calls.find(
    (call) => call.id === "t3.ui/notifications" && call.method === "notify",
  );
  NodeAssert.ok(notify);
  NodeAssert.equal(notify.input.severity, "error");
  const unregister = calls.find(
    (call) => call.id === "t3.ui/keybindings" && call.method === "unregisterCommands",
  );
  NodeAssert.ok(unregister);
  NodeAssert.equal(unregister.input.commandSetToken, "global-tok");
  NodeAssert.equal(
    calls.some((call) => call.method === "listSurfaces"),
    false,
  );
});

NodeTest.test("unavailable toggles still report and withdraw when notify is denied", async () => {
  const { host, calls } = fakeHost({
    invoke: (request) => {
      if (request.id === "t3.ui/panels")
        return Promise.reject(new Error("API capability denied: t3.ui/panels"));
      if (request.id === "t3.ui/notifications")
        return Promise.reject(new Error("API capability denied: t3.ui/notify"));
      return { unregistered: true };
    },
  });
  let staged;
  host.registerGlobalCommands = (commands, handler) => {
    staged = { commands, handler };
    return { status: "active", token: "global-tok", onDidChange: () => () => {} };
  };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    stageDiffCommands(host);
    staged.handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
    await flush();
  } finally {
    console.warn = original;
  }
  const unregister = calls.find(
    (call) => call.id === "t3.ui/keybindings" && call.method === "unregisterCommands",
  );
  NodeAssert.ok(unregister);
  NodeAssert.equal(unregister.input.commandSetToken, "global-tok");
  NodeAssert.equal(warnings.length, 1);
  NodeAssert.equal(warnings[0][0], "t3.diff/toggle is unavailable: t3.ui/panels access lost");
});

NodeTest.test("bindDiffViewCommands registers the view set and binds its handler", async () => {
  const { host } = fakeHost({
    invoke: (request) =>
      request.method === "registerCommands"
        ? {
            commandSetToken: "tok-1",
            results: [{ commandId: DIFF_TOGGLE_COMMAND_ID, status: "registered" }],
          }
        : request.method === "listSurfaces"
          ? { surfaces: [] }
          : { unregistered: true },
  });
  const bound = [];
  const disposers = [];
  const session = {
    context: CONTEXT,
    signal: new AbortController().signal,
    bindCommands: (token, handler) => bound.push({ token, handler }),
    onDispose: (cleanup) => disposers.push(cleanup),
  };
  bindDiffViewCommands(host, session);
  await flush();
  NodeAssert.equal(bound.length, 1);
  NodeAssert.equal(bound[0].token, "tok-1");
  NodeAssert.equal(typeof bound[0].handler, "function");
  NodeAssert.equal(disposers.length, 1);
});

NodeTest.test(
  "bindDiffViewCommands stays quiet when registration rejects or the host cannot bind",
  async () => {
    const rejected = fakeHost({
      invoke: () => ({
        commandSetToken: "tok-x",
        results: [{ commandId: DIFF_TOGGLE_COMMAND_ID, status: "rejected", reason: "no grant" }],
      }),
    });
    const bound = [];
    const session = {
      context: CONTEXT,
      signal: new AbortController().signal,
      bindCommands: (token, handler) => bound.push({ token, handler }),
      onDispose: () => {},
    };
    NodeAssert.doesNotThrow(() => bindDiffViewCommands(rejected.host, session));
    await flush();
    NodeAssert.equal(bound.length, 0);

    // A rejected invoke (missing grant / no provider) must not throw.
    const failing = fakeHost({ invoke: () => Promise.reject(new Error("denied")) });
    NodeAssert.doesNotThrow(() => bindDiffViewCommands(failing.host, session));
    await flush();
    NodeAssert.equal(bound.length, 0);

    // A failed grant-enforced probe must not throw either — registration is
    // skipped and the installation tier keeps the command.
    const deadProbe = fakeHost({
      invoke: () => Promise.reject(new Error("no provider")),
    });
    NodeAssert.doesNotThrow(() => bindDiffViewCommands(deadProbe.host, session));
    await flush();
    NodeAssert.equal(bound.length, 0);

    // A host without a binding store throws synchronously from bindCommands —
    // the installation-level staged set remains the dispatch path.
    const noStore = fakeHost({
      invoke: () => ({
        commandSetToken: "tok-1",
        results: [{ commandId: DIFF_TOGGLE_COMMAND_ID, status: "registered" }],
      }),
    });
    const throwingSession = {
      context: CONTEXT,
      signal: new AbortController().signal,
      bindCommands: () => {
        throw new Error("Command binding is unavailable");
      },
      onDispose: () => {},
    };
    NodeAssert.doesNotThrow(() => bindDiffViewCommands(noStore.host, throwingSession));
    await flush();
  },
);

NodeTest.test(
  "bindDiffViewCommands never offers the command when the panels grant is denied",
  async () => {
    // Ops stay reachable (getCapabilities reports all true) but the
    // grant-enforced listSurfaces read is denied — registration must not run.
    const { host, calls } = fakeHost({
      invoke: (request) => {
        if (request.id === "t3.ui/panels")
          return Promise.reject(new Error("API capability denied: t3.ui/panels"));
        return {
          commandSetToken: "tok-1",
          results: [{ commandId: DIFF_TOGGLE_COMMAND_ID, status: "registered" }],
        };
      },
    });
    const bound = [];
    const session = {
      context: CONTEXT,
      signal: new AbortController().signal,
      bindCommands: (token, handler) => bound.push({ token, handler }),
      onDispose: () => {},
    };
    bindDiffViewCommands(host, session);
    await flush();
    NodeAssert.equal(bound.length, 0);
    NodeAssert.equal(
      calls.some((call) => call.method === "registerCommands"),
      false,
    );
    NodeAssert.equal(
      calls.some((call) => call.method === "listSurfaces"),
      true,
    );
  },
);

NodeTest.test("a revoked panels grant withdraws the view command at dispatch", async () => {
  // The bind-time listSurfaces probe succeeds (grant present), then the
  // grant is revoked before dispatch — the op read denies and the set
  // withdraws itself.
  let lists = 0;
  const { host, calls } = fakeHost({
    invoke: (request) => {
      if (request.id === "t3.ui/keybindings") {
        if (request.method === "registerCommands")
          return {
            commandSetToken: "tok-1",
            results: [{ commandId: DIFF_TOGGLE_COMMAND_ID, status: "registered" }],
          };
        return { unregistered: true };
      }
      if (request.id === "t3.ui/panels" && request.method === "listSurfaces") {
        lists += 1;
        if (lists > 1) return Promise.reject(new Error("API capability denied: t3.ui/panels"));
        return { surfaces: [] };
      }
      return { notificationId: "n-1" };
    },
  });
  const bound = [];
  const session = {
    context: CONTEXT,
    signal: new AbortController().signal,
    bindCommands: (token, handler) => bound.push({ token, handler }),
    onDispose: () => {},
  };
  bindDiffViewCommands(host, session);
  await flush();
  NodeAssert.equal(bound.length, 1);
  bound[0].handler({ commandId: DIFF_TOGGLE_COMMAND_ID, context: CONTEXT });
  await flush();
  const unregister = calls.find(
    (call) => call.id === "t3.ui/keybindings" && call.method === "unregisterCommands",
  );
  NodeAssert.ok(unregister);
  NodeAssert.equal(unregister.input.commandSetToken, "tok-1");
  const notify = calls.find(
    (call) => call.id === "t3.ui/notifications" && call.method === "notify",
  );
  NodeAssert.ok(notify);
  NodeAssert.equal(notify.input.title, "The diff panel toggle is unavailable");
});

NodeTest.test("watchThemeTokens resolves tokens and re-resolves on stream events", async () => {
  let reads = 0;
  const seen = [];
  const { host } = fakeHost({
    invoke: () => ({ tokens: { border: `#${++reads}` }, cssVars: {} }),
    subscribe: () => streamOf([{ type: "snapshot" }, { type: "data" }]),
  });
  watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens));
  await flush();
  NodeAssert.equal(reads, 3);
  // Stream end is a lost subscription: overrides clear to static fallbacks.
  NodeAssert.deepEqual(seen, [{ border: "#1" }, { border: "#2" }, { border: "#3" }, null]);
});

NodeTest.test(
  "watchThemeTokens publishes only the latest read — stale responses lose",
  async () => {
    const reads = [];
    const stream = manualStream();
    const { host } = fakeHost({
      invoke: () => {
        const read = deferred();
        reads.push(read);
        return read.promise;
      },
      subscribe: () => stream.iterable,
    });
    const seen = [];
    watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens));
    await flush();
    NodeAssert.equal(reads.length, 1);
    stream.push({ type: "data" });
    await flush();
    NodeAssert.equal(reads.length, 2);
    // The newer read resolves first; the stale read must not overwrite it.
    reads[1].resolve({ tokens: { border: "#new" }, cssVars: {} });
    await flush();
    reads[0].resolve({ tokens: { border: "#old" }, cssVars: {} });
    await flush();
    NodeAssert.deepEqual(seen, [{ border: "#new" }]);
  },
);

NodeTest.test(
  "watchThemeTokens: a stale read's failure cannot clear a newer resolution",
  async () => {
    const reads = [];
    const stream = manualStream();
    const { host } = fakeHost({
      invoke: () => {
        const read = deferred();
        reads.push(read);
        return read.promise;
      },
      subscribe: () => stream.iterable,
    });
    const seen = [];
    watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens));
    await flush();
    stream.push({ type: "data" });
    await flush();
    NodeAssert.equal(reads.length, 2);
    reads[1].resolve({ tokens: { border: "#new" }, cssVars: {} });
    await flush();
    reads[0].reject(new Error("stale transport failure"));
    await flush();
    NodeAssert.deepEqual(seen, [{ border: "#new" }]);
  },
);

NodeTest.test("watchThemeTokens clears overrides when the subscription is lost", async () => {
  const reads = [];
  const stream = manualStream();
  const { host } = fakeHost({
    invoke: () => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    subscribe: () => stream.iterable,
  });
  const seen = [];
  watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens));
  await flush();
  reads[0].resolve({ tokens: { border: "#live" }, cssVars: {} });
  await flush();
  NodeAssert.deepEqual(seen, [{ border: "#live" }]);
  // The stream dies while a refresh is in flight: the pump observes the
  // failure without waiting on the read, the generation fences the late
  // response, and the overrides clear — "#late" is never published.
  stream.push({ type: "data" });
  await flush();
  NodeAssert.equal(reads.length, 2);
  stream.fail(new Error("connection lost"));
  await flush();
  NodeAssert.deepEqual(seen, [{ border: "#live" }, null]);
  reads[1].resolve({ tokens: { border: "#late" }, cssVars: {} });
  await flush();
  NodeAssert.deepEqual(seen, [{ border: "#live" }, null]);
});

NodeTest.test("watchThemeTokens clears on failed reads — no stale retention", async () => {
  let call = 0;
  const seen = [];
  const { host } = fakeHost({
    invoke: () =>
      ++call === 1
        ? Promise.resolve({ tokens: { border: "#live" }, cssVars: {} })
        : Promise.reject(new Error("grant revoked")),
    subscribe: () => streamOf([{ type: "data" }, { type: "closed" }]),
  });
  watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens));
  await flush();
  NodeAssert.deepEqual(seen, [{ border: "#live" }, null, null]);
});

NodeTest.test(
  "watchThemeTokens keeps the panel on fallbacks when the contract is unavailable",
  async () => {
    const seen = [];
    const { host } = fakeHost({
      invoke: () => Promise.reject(new Error("grant denied")),
      subscribe: () => streamOf([{ type: "data" }]),
    });
    NodeAssert.doesNotThrow(() =>
      watchThemeTokens(host, CONTEXT, new AbortController().signal, (tokens) => seen.push(tokens)),
    );
    await flush();
    // Every publication is the cleared state — never stale tokens.
    NodeAssert.ok(seen.length > 0);
    NodeAssert.ok(seen.every((tokens) => tokens === null));
  },
);

NodeTest.test("watchThemeTokens honors an aborted signal", async () => {
  const seen = [];
  const { host } = fakeHost({
    invoke: () => ({ tokens: { border: "#x" }, cssVars: {} }),
    subscribe: () => streamOf([{ type: "data" }]),
  });
  const controller = new AbortController();
  controller.abort();
  watchThemeTokens(host, CONTEXT, controller.signal, (tokens) => seen.push(tokens));
  await flush();
  NodeAssert.equal(seen.length, 0);
});

NodeTest.test("view-scoped commands carry no activation or key", () => {
  NodeAssert.equal(DIFF_TOGGLE_VIEW_COMMANDS.length, 1);
  const descriptor = DIFF_TOGGLE_VIEW_COMMANDS[0];
  NodeAssert.equal(descriptor.id, DIFF_TOGGLE_COMMAND_ID);
  NodeAssert.equal(descriptor.scope, "thread");
  NodeAssert.equal(descriptor.defaultKey, undefined);
  NodeAssert.equal(descriptor.activation, undefined);
});
