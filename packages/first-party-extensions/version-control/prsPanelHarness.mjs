/**
 * Mounts the REAL prsPanel.tsx — bundled by esbuild into the system tmpdir,
 * never into the package — under react-test-renderer with a scripted host.
 * Each API method answers from `handlers` (`"<api id>#<method>"`); a handler
 * may return a pending promise so a test decides which read lands first.
 * Mock nodes record focus, so keyboard rules can be asserted by name.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
export const React = require("react");
const { act, create } = require("react-test-renderer");
export { act };

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Bundles `prsPanel.tsx` once and imports its exports. */
export async function loadPrsPanel(entryPoint = "prsPanel.tsx") {
  const built = await build({
    entryPoints: [NodePath.join(packageDir, entryPoint)],
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "external-react",
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-prs-panel-"));
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    return await import(NodeURL.pathToFileURL(bundlePath).href);
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise and the React updates it queued land. */
export async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await new Promise((next) => setImmediate(next));
  });
}

export const REF = { host: "github.com", repository: "o/r", number: 3 };

const readOperations = {
  "prs.list": true,
  "prs.listStats": false,
  "prs.summary": true,
  "prs.detail": true,
  "prs.activity": true,
  "prs.threadComments": false,
  "prs.linkedThreads": true,
  "prs.stack": true,
  "prs.reviewerCandidates": false,
  "prs.labelCandidates": false,
  "prs.invalidate": true,
  "prs.streamDiff": false,
  "prs.streamDiffFileContents": false,
  "prs.subscribeRefreshes": true,
};

const writeOperations = {
  "prs.runAction": true,
  "prs.update": false,
  "prs.comment": false,
  "prs.updateComment": false,
  "prs.submitReview": false,
  "prs.replyToThread": false,
  "prs.setThreadResolution": false,
  "prs.setReaction": false,
  "prs.requestReviewers": false,
  "prs.setLabels": false,
};

export const layer = (number, overrides = {}) => ({
  number,
  title: `Layer ${number}`,
  headBranch: `b${number}`,
  headSha: `sha${number}`,
  state: "open",
  ...overrides,
});

export const stackOf = (layers) => ({
  id: "s",
  number: 40,
  url: "https://github.com/o/r/stacks/40",
  base: "main",
  layers,
});

export const detailOf = (overrides = {}) => ({
  provider: "github",
  capabilities: {
    diff: false,
    comment: false,
    actions: ["merge", "enable-auto-merge", "disable-auto-merge", "draft", "ready", "close"],
    mergeMethods: ["merge", "squash", "rebase"],
    search: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    stacks: true,
    stackActions: true,
  },
  viewerPermissions: {
    actions: ["merge", "enable-auto-merge", "disable-auto-merge", "draft", "ready", "close"],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: "p1",
  projectTitle: "Project",
  workspaceRoot: "/w",
  repository: "o/r",
  number: 3,
  title: "Layer 3",
  body: "",
  url: "https://github.com/o/r/pull/3",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "b3",
  baseBranch: "b2",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  autoMergeEnabled: false,
  ...overrides,
});

/** Host answers for an open, stackable pull request; override any key. */
export function defaultHandlers(overrides = {}) {
  return {
    "t3.prs/read#getCapabilities": () => ({
      hosted: true,
      reason: null,
      detail: null,
      providers: [],
      operations: readOperations,
    }),
    "t3.prs/write#getCapabilities": () => ({
      hosted: true,
      reason: null,
      detail: null,
      operations: writeOperations,
      actions: ["merge", "enable-auto-merge", "disable-auto-merge", "draft", "ready", "close"],
      mergeMethods: ["merge", "squash", "rebase"],
      updateMethods: ["merge", "rebase"],
      verdicts: [],
    }),
    "t3.vcs/actions#getCapabilities": () => ({
      detected: true,
      operations: { "actions.preparePullRequestThread": true },
    }),
    "t3.prs/read#list": () => ({
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: false,
      nextCursors: {},
    }),
    "t3.prs/read#detail": () => detailOf(),
    "t3.prs/read#activity": () => ({
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
      truncated: false,
    }),
    "t3.prs/read#linkedThreads": () => ({ threads: [], truncated: false }),
    "t3.prs/read#stack": () => stackOf([layer(2), layer(3), layer(4)]),
    "t3.prs/read#invalidate": () => ({}),
    "t3.prs/write#runAction": () => ({}),
    "t3.ui/notifications#getCapabilities": () => ({
      adapter: "none",
      operations: {},
      clients: [],
    }),
    ...overrides,
  };
}

/** Readable name of a rendered node: its accessible label, else its text. */
export function nodeName(node) {
  if (typeof node === "string") return node;
  const label = node.props?.["aria-label"];
  if (typeof label === "string") return label;
  const text = [];
  const walk = (value) => {
    if (typeof value === "string" || typeof value === "number") text.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value?.props?.children !== undefined) walk(value.props.children);
  };
  walk(node.props?.children);
  return text.join("").trim();
}

/**
 * Mounts `element` against a scripted host. `refreshes` pushes one
 * `refreshed` frame down the host refresh stream. `members` adds host
 * members (preferences, floating layer) to the scripted host.
 */
export function mount(render, handlers, members = {}) {
  const calls = [];
  const refreshListeners = new Set();
  const focus = { current: null };
  const scrolls = [];
  globalThis.document = {
    get activeElement() {
      return focus.current;
    },
  };
  const host = {
    React,
    invokeApi(request) {
      calls.push(request);
      const handler = handlers[`${request.id}#${request.method}`];
      if (handler === undefined)
        return Promise.reject(new Error(`unexpected ${request.id}#${request.method}`));
      return Promise.resolve().then(() => handler(request.input, request));
    },
    subscribeApi(request, signal) {
      return (async function* () {
        if (request.name !== "subscribeRefreshes") {
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          return;
        }
        while (!signal.aborted) {
          const next = await new Promise((resolve) => {
            const listener = () => resolve(true);
            refreshListeners.add(listener);
            signal.addEventListener("abort", () => {
              refreshListeners.delete(listener);
              resolve(false);
            });
          });
          if (!next) return;
          yield { streamId: "r", sequence: 0, type: "data", value: { kind: "refreshed" } };
        }
      })();
    },
    discoverApis: async () => [],
    invokeTool: async () => null,
    ...members,
  };
  const controller = new AbortController();
  const session = {
    context: { resource: { projectId: "p1" }, client: "web" },
    signal: controller.signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: async () => null,
    bindCommands: () => "b",
    setTabIndicators: () => true,
    onDispose: () => {},
  };
  let renderer;
  act(() => {
    renderer = create(render(host, session), {
      createNodeMock: (element) => {
        const mock = {
          name: nodeName(element),
          focus() {
            focus.current = mock;
          },
          scrollIntoView(options) {
            scrolls.push({ name: mock.name, options });
          },
          contains: () => false,
        };
        return mock;
      },
    });
  });
  const all = () => renderer.root.findAll((node) => typeof node.type === "string");
  const byName = (name) => all().filter((node) => nodeName(node) === name);
  return {
    host,
    session,
    calls,
    renderer,
    focused: () => focus.current?.name ?? null,
    scrolls: () => scrolls,
    byName,
    find(name) {
      const found = byName(name);
      if (found.length !== 1)
        throw new Error(`expected one node named ${JSON.stringify(name)}, found ${found.length}`);
      return found[0];
    },
    has: (name) => byName(name).length > 0,
    text: () => {
      const json = renderer.toJSON();
      const text = [];
      const walk = (value) => {
        if (typeof value === "string") text.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value?.children) walk(value.children);
      };
      walk(json);
      return text.join("");
    },
    writes: () =>
      calls.filter((call) => call.id === "t3.prs/write" && call.method !== "getCapabilities"),
    async refresh() {
      for (const listener of [...refreshListeners]) listener();
      refreshListeners.clear();
      await flush();
    },
    update(next) {
      act(() => renderer.update(next(host, session)));
    },
    unmount() {
      act(() => renderer.unmount());
      controller.abort();
    },
  };
}

/** Delivers a React synthetic event to `node`, then up through its ancestors. */
export function dispatch(node, handler, init = {}) {
  const event = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    currentTarget: { contains: () => true },
    ...init,
  };
  act(() => {
    for (let cursor = node; cursor && !event.propagationStopped; cursor = cursor.parent) {
      const listener = cursor.props?.[handler];
      if (typeof listener === "function") listener(event);
    }
  });
  return event;
}
