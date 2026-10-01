/**
 * The REAL BrowserView, bundled by esbuild, across a backend restart (D13):
 * the socket drops, the server comes back on a new epoch with no sessions,
 * and the next address the user enters must open a fresh session and present
 * it — no raw socket error or epoch text left behind. The host fake follows
 * the real ones: resumable streams suspend and resume with a fresh snapshot,
 * plain streams fail with the socket's close error, and the surface ends a
 * lease whose epoch the synced state has moved past.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The slot hook measures and observes its element; a fixed on-screen box is enough.
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ overflowX: "visible", overflowY: "visible" });

function nodeMock() {
  const element = {
    parentElement: null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contains: (node) => node === element,
    focus() {},
    blur() {},
    select() {},
  };
  element.ownerDocument = {
    documentElement: {},
    defaultView: globalThis.window,
    elementsFromPoint: () => [element],
  };
  return element;
}

let bundle;
NodeTest.before(async () => {
  const built = await build({
    stdin: {
      contents:
        NodeFS.readFileSync(NodePath.join(packageDir, "extension.tsx"), "utf8") +
        "\nexport { BrowserView };",
      resolveDir: packageDir,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "external-react",
        setup(builder) {
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-reconnect-"));
  const path = NodePath.join(dir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(path, built.outputFiles[0].text);
    bundle = await import(NodeURL.pathToFileURL(path).href);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

function browserSession(tabId, url, title) {
  return {
    tabId,
    requestedUrl: url,
    navigation: { kind: "loaded", url, title },
    canGoBack: false,
    canGoForward: false,
    viewport: { _tag: "fill" },
    engine: { state: "ready", generation: `gen-${tabId}` },
    zoomFactor: 1,
    appearance: null,
    audioMuted: false,
    audible: false,
    devToolsOpen: false,
    pictureInPicture: false,
  };
}

const onAbort = (signal, resolve) => signal.addEventListener("abort", resolve, { once: true });

/**
 * One server process at a time. `drop()` kills the socket; `restart()` brings
 * the server back on a new epoch whose revisions start over and which holds
 * no sessions, like a restarted preview manager.
 */
function restartingBackend() {
  const server = {
    epoch: "epoch-a",
    revision: 40,
    sessions: [browserSession("tab-a", "https://a.test/", "Page A")],
  };
  let up = true;
  let drops = new Set();
  let restarts = new Set();
  // Live subscribers' queued deltas, and the gate a test may hold before the
  // next snapshot completes (the server queues deltas behind the snapshot).
  const subscribers = new Set();
  let snapshotGate = null;
  const surfaceWatchers = new Set();
  const acquires = [];
  const presents = [];
  const navigates = [];
  const opens = [];
  const surfaceRefreshes = [];
  // The host's synced epoch trails the server's until `syncSurface()`.
  let hostEpoch = server.epoch;
  let nextSurfaceDenial = null;
  let surfaceSyncDelayMs = 0;
  let navigateGate = null;
  let nextOpenEngine = null;
  let engineClaimPending = true;
  const socketClosed = () => new Error("SocketCloseError: 1006");
  const hang = (signal) => new Promise((resolve) => onAbort(signal, resolve));

  function syncSurface() {
    hostEpoch = server.epoch;
    for (const watch of surfaceWatchers) watch();
  }

  function snapshotFrames() {
    const snapshotId = `snapshot-${server.epoch}`;
    const meta = { snapshotId, serverEpoch: server.epoch, revision: server.revision };
    const count = server.sessions.length;
    return [
      { kind: "snapshot-start", ...meta, sessionCount: count },
      { kind: "snapshot-chunk", snapshotId, chunkIndex: 0, sessions: [...server.sessions] },
      { kind: "snapshot-complete", ...meta, sessionCount: count },
    ];
  }

  /** `onSuspended` present: host-resumed; absent: the plain transport-bound stream. */
  function sessionEvents(signal, resumable, onSuspended) {
    return {
      async *[Symbol.asyncIterator]() {
        let sequence = 0;
        for (;;) {
          if (!up) {
            await new Promise((resolve) => {
              restarts.add(resolve);
              onAbort(signal, resolve);
            });
          }
          if (signal.aborted) return;
          const subscriber = { queue: [], wake: null };
          subscribers.add(subscriber);
          const [start, chunk, complete] = snapshotFrames();
          yield { streamId: "events", type: "data", sequence: ++sequence, value: start };
          yield { streamId: "events", type: "data", sequence: ++sequence, value: chunk };
          if (snapshotGate) await snapshotGate;
          yield { streamId: "events", type: "data", sequence: ++sequence, value: complete };
          for (;;) {
            if (!up || signal.aborted) break;
            const value = subscriber.queue.shift();
            if (value) {
              yield { streamId: "events", type: "data", sequence: ++sequence, value };
              continue;
            }
            await new Promise((resolve) => {
              subscriber.wake = resolve;
              drops.add(resolve);
              onAbort(signal, resolve);
            });
          }
          subscribers.delete(subscriber);
          if (signal.aborted) return;
          if (!resumable) throw socketClosed();
          onSuspended?.();
          sequence = 0;
        }
      },
    };
  }

  const host = {
    React,
    async invokeApi(request) {
      if (request.id !== "t3.browser/sessions") throw new Error("API unavailable");
      if (!up) throw socketClosed();
      if (request.method === "open") {
        opens.push(request.input.url);
        server.revision += 1;
        const tabId = opens.length === 1 ? "tab-b" : `tab-b-${opens.length}`;
        const session = browserSession(tabId, request.input.url, "Page B");
        if (nextOpenEngine) {
          session.engine = nextOpenEngine;
          session.navigation = { kind: "pending", url: request.input.url, title: "" };
          nextOpenEngine = null;
        }
        server.sessions.push(session);
        for (const subscriber of subscribers) {
          subscriber.queue.push({ kind: "session-upsert", revision: server.revision, session });
          subscriber.wake?.();
        }
        return {
          commandId: `open-${server.revision}`,
          outcome: "accepted",
          serverEpoch: server.epoch,
          revision: server.revision,
          session,
        };
      }
      if (request.method === "navigate") {
        navigates.push(request.input.serverEpoch);
        const gate = navigateGate;
        navigateGate = null;
        if (gate) await gate;
      }
      if (request.method === "navigate" && request.input.serverEpoch !== server.epoch)
        throw new Error("BrowserStaleServerEpoch: the request epoch does not match");
      if (request.method === "navigate") {
        const index = server.sessions.findIndex((session) => session.tabId === request.input.tabId);
        if (index === -1) throw new Error("session not found");
        server.revision += 1;
        const session = browserSession(request.input.tabId, request.input.url, "Page B");
        server.sessions[index] = session;
        for (const subscriber of subscribers) {
          subscriber.queue.push({ kind: "session-upsert", revision: server.revision, session });
          subscriber.wake?.();
        }
        return {
          commandId: `navigate-${server.revision}`,
          outcome: "accepted",
          serverEpoch: server.epoch,
          revision: server.revision,
          session,
        };
      }
      throw new Error("API unavailable");
    },
    subscribeApi(request, signal) {
      if (request.id === "t3.browser/sessions" && request.name === "events")
        return sessionEvents(signal, false);
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => hang(signal).then(() => ({ done: true, value: undefined })),
        }),
      };
    },
    resumableStreams: {
      version: 4,
      subscribeApi(request, signal, options) {
        if (request.id !== "t3.browser/sessions" || request.name !== "events")
          throw new Error(`${request.id}#${request.name} is not resumable`);
        return sessionEvents(signal, true, options?.onSuspended);
      },
    },
    browserSurface: {
      id: "t3.browser/surface",
      version: "2.0.0",
      presentation: { supported: true },
      get engineClaimPending() {
        return engineClaimPending;
      },
      acquire(request) {
        acquires.push({ tabId: request.session.tabId, serverEpoch: request.session.serverEpoch });
        if (nextSurfaceDenial) {
          const reason = nextSurfaceDenial;
          nextSurfaceDenial = null;
          if (reason === "epoch-changed") server.sessions = [];
          return { ok: false, denial: { reason, detail: "presentation denied" } };
        }
        if (request.session.serverEpoch !== hostEpoch) {
          surfaceRefreshes.push(request.session.serverEpoch);
          return new Promise((resolve) => {
            setTimeout(() => {
              if (surfaceSyncDelayMs === null) {
                resolve({ ok: false, denial: { reason: "host-unavailable", detail: "offline" } });
                return;
              }
              syncSurface();
              resolve(
                request.session.serverEpoch === hostEpoch
                  ? attach()
                  : { ok: false, denial: { reason: "epoch-changed", detail: "stale session" } },
              );
            }, surfaceSyncDelayMs ?? 30_000);
          });
        }
        return attach();
        function attach() {
          const listeners = new Set();
          const lease = {
            session: request.session,
            state: { kind: "active", presentation: { supported: true }, engineClaimPending },
            onDidChangeState(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            present(rect, visible) {
              if (lease.state.kind === "ended") return "ended";
              presents.push({
                tabId: request.session.tabId,
                serverEpoch: request.session.serverEpoch,
                visible,
              });
              return "accepted";
            },
            release() {
              end("released");
            },
          };
          const end = (reason) => {
            if (lease.state.kind === "ended") return;
            lease.state = { kind: "ended", reason };
            surfaceWatchers.delete(watch);
            for (const listener of listeners) listener(lease.state);
          };
          // The host's synced sessions: a new epoch ends every older lease.
          const watch = (reason) => {
            if (reason) end(reason);
            else if (hostEpoch !== request.session.serverEpoch) end("epoch-changed");
            else if (lease.state.engineClaimPending !== engineClaimPending) {
              lease.state = { ...lease.state, engineClaimPending };
              for (const listener of listeners) listener(lease.state);
            }
          };
          surfaceWatchers.add(watch);
          return { ok: true, lease };
        }
      },
    },
  };

  return {
    host,
    acquires,
    presents,
    surfaceRefreshes,
    serverSessions: () => server.sessions,
    reportSession(session) {
      server.revision += 1;
      const index = server.sessions.findIndex((current) => current.tabId === session.tabId);
      server.sessions[index] = session;
      for (const subscriber of subscribers) {
        subscriber.queue.push({ kind: "session-upsert", revision: server.revision, session });
        subscriber.wake?.();
      }
    },
    setNextOpenEngine(engine) {
      nextOpenEngine = engine;
    },
    setEngineClaimPending(pending) {
      engineClaimPending = pending;
      for (const watch of surfaceWatchers) watch();
    },
    denyNextSurface(reason) {
      nextSurfaceDenial = reason;
    },
    delaySurfaceSync(ms) {
      surfaceSyncDelayMs = ms;
    },
    drop() {
      up = false;
      const pending = drops;
      drops = new Set();
      for (const resolve of pending) resolve();
    },
    resume() {
      up = true;
      syncSurface();
      const pending = restarts;
      restarts = new Set();
      for (const resolve of pending) resolve();
    },
    syncSurface,
    endSurface(reason) {
      for (const watch of surfaceWatchers) watch(reason);
    },
    navigates: () => navigates,
    opens: () => opens,
    /** Holds the next navigate's response; returns the release. */
    holdNavigate() {
      let release;
      navigateGate = new Promise((resolve) => (release = resolve));
      return release;
    },
    /** Holds the next snapshot before its `snapshot-complete`; returns the release. */
    holdSnapshot() {
      let release;
      snapshotGate = new Promise((resolve) => {
        release = () => {
          snapshotGate = null;
          resolve();
        };
      });
      return release;
    },
    /**
     * `syncSurface: false` leaves the host's synced epoch behind (its lease
     * stays active) until `syncSurface()`, as when an address is entered
     * right as the server comes back.
     */
    restart({ syncSurface = true, serverEpoch = "epoch-b" } = {}) {
      server.epoch = serverEpoch;
      server.revision = 1;
      server.sessions = [];
      up = true;
      if (syncSurface) this.syncSurface();
      const pending = restarts;
      restarts = new Set();
      for (const resolve of pending) resolve();
    },
  };
}

function viewSession() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    context: {
      client: "desktop",
      resource: {
        namespace: "t3.browser",
        id: "view",
        environmentId: "env-a",
        projectId: "project-a",
        threadId: "thread-a",
      },
    },
    visible: true,
    restoreState: { url: "https://a.test/", tabId: "tab-a", serverEpoch: "epoch-a" },
    save() {},
    onVisibility: () => () => {},
    bindCommands: () => () => {},
  };
}

const textOf = (node) =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : (node?.children ?? []).map(textOf).join("");

/** Drains the fake transport's promise chains and React's resulting renders. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 20; round += 1)
      await new Promise((resolve) => setImmediate(resolve));
  });
}

/** Mounts the real view on `backend`; `run` drives it, and the view unmounts after. */
async function withView(
  backend,
  run,
  { initialStatus = "Page A — engine ready, navigation loaded" } = {},
) {
  const view = viewSession();
  let renderer;
  const remoteElement = nodeMock();
  const statusCommits = [];
  const status = () =>
    textOf(
      renderer.root.find(
        (node) => node.type === "div" && node.props["aria-label"] === "Browser status",
      ),
    );
  await act(async () => {
    renderer = create(
      React.createElement(
        React.Profiler,
        { id: "Browser status", onRender: () => statusCommits.push(status()) },
        React.createElement(bundle.BrowserView, { host: backend.host, session: view }),
      ),
      {
        createNodeMock: (node) =>
          node.props["aria-label"] === "Remote browser surface" ? remoteElement : nodeMock(),
      },
    );
  });
  const hasSurface = () =>
    renderer.root.findAll(
      (node) => node.type === "div" && node.props["aria-label"] === "Browser surface",
    ).length > 0;
  const addressInput = () =>
    renderer.root.find((node) => node.type === "input" && node.props["aria-label"] === "Address");
  /** Types `url` into the address bar and presses Enter; no `url` focuses the bar and presses Enter on what it shows. */
  const enter = async (url) => {
    const address = addressInput();
    await act(async () => {
      if (url === undefined) address.props.onFocus({ currentTarget: { select() {} } });
      else address.props.onChange({ target: { value: url } });
    });
    await act(async () => {
      address.props.onKeyDown({
        key: "Enter",
        preventDefault() {},
        currentTarget: { blur() {} },
      });
    });
  };
  try {
    await settle();
    if (initialStatus !== null) {
      NodeAssert.equal(status(), initialStatus);
      NodeAssert.deepEqual(backend.presents.at(-1), {
        tabId: "tab-a",
        serverEpoch: "epoch-a",
        visible: true,
      });
    }
    await run({
      status,
      statusCommits,
      hasSurface,
      enter,
      address: () => addressInput().props.value,
      text: () => textOf(renderer.toJSON()),
      refresh: async () => {
        await act(async () => {
          renderer.root
            .find((node) => node.type === "button" && node.props["aria-label"] === "Stop")
            .props.onClick();
        });
      },
    });
  } finally {
    await act(async () => {
      view.controller.abort();
      renderer.unmount();
    });
  }
}

const unreportedEngine = {
  state: "unavailable",
  generation: null,
  reason: "desktop-required",
};

function unreportedSession(backend) {
  const session = backend.serverSessions()[0];
  return {
    ...session,
    engine: unreportedEngine,
    navigation: { kind: "pending", url: session.requestedUrl, title: "" },
  };
}

NodeTest.test(
  "surface-capable attach and re-attach never commit unavailable engine status before a claim",
  async () => {
    const backend = restartingBackend();
    backend.reportSession(unreportedSession(backend));
    await withView(
      backend,
      async ({ status, statusCommits, enter }) => {
        NodeAssert.ok(statusCommits.length > 0);
        NodeAssert.doesNotMatch(statusCommits.join("\n"), /engine unavailable|desktop-required/);
        NodeAssert.equal(status(), "https://a.test/ — engine pending, navigation pending");

        backend.reportSession({
          ...backend.serverSessions()[0],
          engine: { state: "starting", generation: "gen-tab-a" },
        });
        await settle();
        NodeAssert.equal(status(), "https://a.test/ — engine starting, navigation pending");
        backend.reportSession(browserSession("tab-a", "https://a.test/", "Page A"));
        await settle();
        NodeAssert.equal(status(), "Page A — engine ready, navigation loaded");

        backend.drop();
        await settle();
        backend.reportSession(unreportedSession(backend));
        backend.resume();
        await settle();
        NodeAssert.equal(status(), "https://a.test/ — engine pending, navigation pending");
        NodeAssert.equal(backend.opens().length, 0);
        backend.reportSession(browserSession("tab-a", "https://a.test/", "Page A"));
        await settle();

        backend.drop();
        await settle();
        backend.restart();
        await settle();
        backend.setNextOpenEngine(unreportedEngine);
        await enter("https://b.test/");
        await settle();
        NodeAssert.equal(status(), "https://b.test/ — engine pending, navigation pending");
        NodeAssert.equal(backend.opens().length, 1);
        backend.reportSession(browserSession("tab-b", "https://b.test/", "Page B"));
        await settle();
        NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
        NodeAssert.doesNotMatch(statusCommits.join("\n"), /engine unavailable|desktop-required/);
      },
      { initialStatus: null },
    );
  },
);

NodeTest.test("remote-environment desktop does not wait for a claim it cannot make", async () => {
  const backend = restartingBackend();
  backend.reportSession(unreportedSession(backend));
  backend.setEngineClaimPending(false);
  await withView(
    backend,
    async ({ status, statusCommits }) => {
      NodeAssert.equal(
        status(),
        "https://a.test/ — engine unavailable (desktop-required), navigation pending",
      );
      NodeAssert.doesNotMatch(statusCommits.join("\n"), /engine pending/);
    },
    { initialStatus: null },
  );
});

NodeTest.test("a failed primary claim promptly ends the pending status", async () => {
  const backend = restartingBackend();
  backend.reportSession(unreportedSession(backend));
  await withView(
    backend,
    async ({ status }) => {
      NodeAssert.match(status(), /engine pending/);
      backend.setEngineClaimPending(false);
      await settle();
      NodeAssert.equal(
        status(),
        "https://a.test/ — engine unavailable (desktop-required), navigation pending",
      );
    },
    { initialStatus: null },
  );
});

NodeTest.test("attach-time page verbs never name an unavailable engine", async () => {
  const backend = restartingBackend();
  backend.reportSession(unreportedSession(backend));
  await withView(
    backend,
    async ({ refresh, text, statusCommits }) => {
      await refresh();
      NodeAssert.match(text(), /engine pending, navigation pending/);
      NodeAssert.doesNotMatch(text(), /engine unavailable|desktop-required/);
      backend.reportSession(browserSession("tab-a", "https://a.test/", "Page A"));
      await settle();
      NodeAssert.match(text(), /engine ready, navigation loaded/);
      NodeAssert.doesNotMatch(statusCommits.join("\n"), /engine unavailable|desktop-required/);
    },
    { initialStatus: null },
  );
});

NodeTest.test(
  "a failed claim after an attach-time verb does not leave a pending notice",
  async () => {
    const backend = restartingBackend();
    backend.reportSession(unreportedSession(backend));
    await withView(
      backend,
      async ({ refresh, status }) => {
        await refresh();
        backend.setEngineClaimPending(false);
        await settle();
        NodeAssert.equal(
          status(),
          "https://a.test/ — engine unavailable (desktop-required), navigation pending",
        );
      },
      { initialStatus: null },
    );
  },
);

for (const surface of [
  "absent",
  "unsupported",
  "lease-unsupported",
  "denied",
  "reported-unavailable",
]) {
  NodeTest.test(`${surface} host retains honest unavailable engine status`, async () => {
    const backend = restartingBackend();
    const session = unreportedSession(backend);
    if (surface === "absent" || surface === "unsupported")
      backend.host.browserFrames = { id: "t3.browser/frames", version: "1.0.0" };
    if (surface === "absent") delete backend.host.browserSurface;
    if (surface === "unsupported")
      backend.host.browserSurface.presentation = { supported: false, reason: "desktop-required" };
    if (surface === "lease-unsupported") {
      const acquire = backend.host.browserSurface.acquire;
      backend.host.browserSurface.acquire = (request) => {
        const acquired = acquire(request);
        acquired.lease.state.presentation = { supported: false, reason: "desktop-required" };
        return acquired;
      };
    }
    if (surface === "denied")
      backend.host.browserSurface.acquire = () => ({
        ok: false,
        denial: { reason: "host-unavailable", detail: "offline" },
      });
    if (surface === "reported-unavailable")
      session.engine = { ...unreportedEngine, generation: "gen-tab-a" };
    backend.reportSession(session);
    await withView(
      backend,
      async ({ status }) => {
        NodeAssert.equal(
          status(),
          "https://a.test/ — engine unavailable (desktop-required), navigation pending",
        );
      },
      { initialStatus: null },
    );
  });
}

const presentingB = (backend, status) => {
  NodeAssert.deepEqual(backend.acquires.at(-1), { tabId: "tab-b", serverEpoch: "epoch-b" });
  NodeAssert.deepEqual(backend.presents.at(-1), {
    tabId: "tab-b",
    serverEpoch: "epoch-b",
    visible: true,
  });
  NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
};

NodeTest.test(
  "after a backend restart the next address opens a fresh session and presents it",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, text }) => {
      backend.drop();
      await settle();
      NodeAssert.equal(status(), "Environment is not connected.");
      backend.restart();
      await settle();
      // Like native's re-list: the old hold drops silently, back to the
      // ordinary empty Browser.
      NodeAssert.equal(hasSurface(), false);
      NodeAssert.match(status(), /^Requested https:\/\/a\.test\/ /);

      await enter("https://b.test/");
      await settle();
      presentingB(backend, status);
      NodeAssert.doesNotMatch(text(), /SocketCloseError|1006|epoch-changed|restarted/);
    });
  },
);

NodeTest.test(
  "an open that lands before the resumed snapshot completes survives that snapshot",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, enter, text }) => {
      backend.drop();
      await settle();
      const release = backend.holdSnapshot();
      backend.restart();
      await settle();
      // The restarted server captured its empty snapshot at revision 1; the
      // user's open lands at revision 2 before that snapshot completes.
      await enter("https://b.test/");
      await settle();
      presentingB(backend, status);
      release();
      await settle();
      presentingB(backend, status);
      NodeAssert.match(text(), /Page B/);
      NodeAssert.doesNotMatch(text(), /Session ended/);
    });
  },
);

NodeTest.test(
  "the restart's ended surface drops silently while the resumed snapshot is pending",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, enter, text }) => {
      backend.drop();
      await settle();
      const release = backend.holdSnapshot();
      backend.restart();
      await settle();
      // The host ended the lease on the new epoch; native drops it silently.
      NodeAssert.doesNotMatch(text(), /Surface ended|epoch-changed/);
      release();
      await settle();
      NodeAssert.doesNotMatch(text(), /Surface ended|epoch-changed/);
      await enter("https://b.test/");
      await settle();
      presentingB(backend, status);
    });
  },
);

NodeTest.test(
  "an address entered as the server returns stays in the bar and opens once the restart is synced",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, address, text }) => {
      backend.drop();
      await settle();
      const release = backend.holdSnapshot();
      // Neither the host's synced epoch nor the resumed snapshot has caught
      // up: the view still holds tab-a on the dead epoch with an active lease.
      backend.restart({ syncSurface: false });
      await settle();
      await enter("https://b.test/");
      await settle();
      NodeAssert.deepEqual(backend.navigates(), ["epoch-a"], "sent to the held session first");
      // No session is opened for an epoch the host has not synced: its
      // surface would be denied for good.
      NodeAssert.deepEqual(backend.opens(), []);
      NodeAssert.equal(hasSurface(), false);
      NodeAssert.doesNotMatch(text(), /BrowserStaleServerEpoch|restarted|again/);
      backend.syncSurface();
      release();
      await settle();
      // The dead hold dropped; the bar shows the address that was entered.
      NodeAssert.equal(address(), "https://b.test/");
      // The user's next Enter opens the address fresh and presents it.
      await enter();
      await settle();
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      presentingB(backend, status);
      NodeAssert.doesNotMatch(text(), /BrowserStaleServerEpoch|Session ended|epoch-changed|again/);
    });
  },
);

NodeTest.test(
  "a delayed stale-navigation rejection opens nothing and keeps the newer address",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, enter, address }) => {
      backend.drop();
      await settle();
      const release = backend.holdSnapshot();
      backend.restart({ syncSurface: false });
      await settle();
      const releaseOlder = backend.holdNavigate();
      await enter("https://older.test/");
      await settle();
      await enter("https://newer.test/");
      await settle();
      releaseOlder();
      await settle();
      NodeAssert.deepEqual(backend.navigates(), ["epoch-a", "epoch-a"]);
      NodeAssert.deepEqual(backend.opens(), [], "a stale rejection opens no session");
      backend.syncSurface();
      release();
      await settle();
      NodeAssert.equal(address(), "https://newer.test/");
      await enter();
      await settle();
      NodeAssert.deepEqual(backend.opens(), ["https://newer.test/"]);
      presentingB(backend, status);
    });
  },
);

NodeTest.test(
  "an epoch-ended presentation drops silently without a sessions reconnect",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, text }) => {
      backend.restart();
      await settle();
      NodeAssert.equal(hasSurface(), false);
      NodeAssert.match(status(), /^Requested https:\/\/a\.test\/ /);
      NodeAssert.deepEqual(backend.opens(), []);
      NodeAssert.doesNotMatch(text(), /Surface ended|epoch-changed|restarted/);

      await enter("https://b.test/");
      await settle();
      NodeAssert.deepEqual(backend.navigates(), []);
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      presentingB(backend, status);
    });
  },
);

NodeTest.test(
  "a genuinely stale acquisition drops silently and the next Enter opens one fresh session",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, text }) => {
      backend.restart();
      await settle();
      backend.denyNextSurface("epoch-changed");
      await enter("https://b.test/");
      await settle();
      NodeAssert.equal(hasSurface(), false);
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      NodeAssert.deepEqual(backend.serverSessions(), []);
      NodeAssert.deepEqual(backend.navigates(), []);
      NodeAssert.equal(backend.acquires.length, 2, "no automatic retry of an epoch denial");
      NodeAssert.doesNotMatch(text(), /Native presentation is unavailable|epoch-changed/);
      await enter();
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/", "https://b.test/"]);
      NodeAssert.equal(backend.serverSessions().length, 1, "no orphaned stale session");
    });
  },
);

NodeTest.test(
  "host-unavailable is silent and the next Enter reattaches without another open",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ hasSurface, enter, text }) => {
      backend.restart();
      await settle();
      backend.denyNextSurface("host-unavailable");
      await enter("https://b.test/");
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing/,
      );
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-a");
      await enter();
      await settle();
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-b");
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      NodeAssert.deepEqual(backend.navigates(), ["epoch-b"]);
      NodeAssert.equal(backend.serverSessions().length, 1);
      NodeAssert.equal(
        backend.acquires.length,
        3,
        "one attach per Enter, without automatic retries",
      );
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing/,
      );
    });
  },
);

NodeTest.test(
  "a fresh session survives a stale host epoch after back-to-back restarts",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, address, text }) => {
      backend.restart();
      await settle();
      NodeAssert.equal(hasSurface(), false);
      backend.restart({ syncSurface: false, serverEpoch: "epoch-c" });
      await settle();
      backend.delaySurfaceSync(6_000);
      await enter("https://b.test/");
      await settle();
      NodeAssert.equal(hasSurface(), true, "a newly opened live session must stay held");
      NodeAssert.deepEqual(backend.acquires.at(-1), { tabId: "tab-b", serverEpoch: "epoch-c" });
      NodeAssert.deepEqual(backend.surfaceRefreshes, ["epoch-c"]);
      NodeAssert.equal(address(), "https://b.test/");
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"], "one open for one Enter");
      NodeAssert.deepEqual(backend.navigates(), []);
      NodeAssert.doesNotMatch(
        text(),
        /Native presentation is unavailable|host-unavailable|epoch-changed|restarted|refreshing/,
      );
      await act(async () => context.mock.timers.tick(5_999));
      await settle();
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-a");
      NodeAssert.doesNotMatch(
        text(),
        /Native presentation is unavailable|host-unavailable|epoch|refreshing/,
      );
      await act(async () => context.mock.timers.tick(1));
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
      NodeAssert.deepEqual(backend.presents.at(-1), {
        tabId: "tab-b",
        serverEpoch: "epoch-c",
        visible: true,
      });
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      NodeAssert.deepEqual(
        backend.serverSessions().map((session) => session.tabId),
        ["tab-b"],
      );
      NodeAssert.doesNotMatch(text(), /Native presentation is unavailable|epoch-changed/);
      NodeAssert.equal(backend.acquires.length, 2, "the pending attach is not retried");
      await enter();
      await settle();
      NodeAssert.deepEqual(backend.navigates(), ["epoch-c"]);
      NodeAssert.deepEqual(
        backend.opens(),
        ["https://b.test/"],
        "Enter navigates the held session",
      );
      NodeAssert.deepEqual(
        backend.serverSessions().map((session) => session.tabId),
        ["tab-b"],
      );
      NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
    });
  },
);

NodeTest.test(
  "a timed-out sync stays silent and the next Enter reattaches after recovery",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const backend = restartingBackend();
    await withView(backend, async ({ hasSurface, enter, text }) => {
      backend.restart();
      await settle();
      backend.restart({ syncSurface: false, serverEpoch: "epoch-c" });
      await settle();
      backend.delaySurfaceSync(null);
      await enter("https://b.test/");
      await settle();
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing/,
      );
      await act(async () => context.mock.timers.tick(30_000));
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-a");
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing/,
      );
      backend.delaySurfaceSync(0);
      await enter();
      await act(async () => context.mock.timers.tick(0));
      await settle();
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-b");
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      NodeAssert.deepEqual(backend.navigates(), ["epoch-c"]);
      NodeAssert.equal(backend.serverSessions().length, 1);
      NodeAssert.equal(backend.acquires.length, 3);
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing/,
      );
    });
  },
);

NodeTest.test(
  "a timed-out sync reattaches on a matching reconnect snapshot without navigation",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, text }) => {
      backend.restart();
      await settle();
      backend.restart({ syncSurface: false, serverEpoch: "epoch-c" });
      await settle();
      backend.delaySurfaceSync(null);
      await enter("https://b.test/");
      await settle();
      await act(async () => context.mock.timers.tick(30_000));
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.equal(backend.presents.at(-1).tabId, "tab-a");
      NodeAssert.equal(backend.acquires.length, 2);
      backend.drop();
      await settle();
      NodeAssert.match(text(), /Environment is not connected/);
      backend.resume();
      await settle();
      NodeAssert.equal(hasSurface(), true);
      NodeAssert.deepEqual(backend.presents.at(-1), {
        tabId: "tab-b",
        serverEpoch: "epoch-c",
        visible: true,
      });
      NodeAssert.equal(status(), "Page B — engine ready, navigation loaded");
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      NodeAssert.deepEqual(backend.navigates(), []);
      NodeAssert.equal(backend.serverSessions().length, 1);
      NodeAssert.equal(backend.acquires.length, 3);
      NodeAssert.doesNotMatch(
        text(),
        /host-unavailable|epoch|Native presentation is unavailable|refreshing|not connected/,
      );
    });
  },
);

NodeTest.test(
  "a stale navigation drops its session without retrying or waiting for reconnect",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, hasSurface, enter, address, text }) => {
      backend.restart({ syncSurface: false });
      await settle();
      await enter("https://b.test/");
      await settle();
      NodeAssert.deepEqual(backend.navigates(), ["epoch-a"]);
      NodeAssert.deepEqual(backend.opens(), [], "a stale rejection opens no session");
      NodeAssert.equal(hasSurface(), false);
      NodeAssert.equal(address(), "https://b.test/");
      NodeAssert.doesNotMatch(text(), /BrowserStaleServerEpoch|epoch-changed|restarted|again/);

      backend.syncSurface();
      await settle();
      NodeAssert.deepEqual(backend.opens(), []);
      await enter();
      await settle();
      NodeAssert.deepEqual(backend.opens(), ["https://b.test/"]);
      presentingB(backend, status);
    });
  },
);

NodeTest.test(
  "a late stale-navigation rejection leaves a freshly opened session alone",
  async () => {
    const backend = restartingBackend();
    await withView(backend, async ({ status, enter, address, text }) => {
      backend.restart({ syncSurface: false });
      const releaseOlder = backend.holdNavigate();
      await enter("https://older.test/");
      await settle();
      backend.syncSurface();
      await settle();
      await enter("https://newer.test/");
      await settle();
      presentingB(backend, status);

      releaseOlder();
      await settle();
      NodeAssert.equal(address(), "https://newer.test/");
      NodeAssert.deepEqual(backend.opens(), ["https://newer.test/"]);
      presentingB(backend, status);
      NodeAssert.doesNotMatch(text(), /BrowserStaleServerEpoch|epoch-changed|restarted|again/);
    });
  },
);
