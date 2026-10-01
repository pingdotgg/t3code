/**
 * The REAL BrowserView, bundled by esbuild, against a host that denies the
 * sessions grant: the panel must name the permission and where to grant it,
 * not show the broker's raw text. The bundle goes to the system tmpdir.
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
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-denial-"));
  const path = NodePath.join(dir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(path, built.outputFiles[0].text);
    bundle = await import(NodeURL.pathToFileURL(path).href);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const DENIAL = new Error(
  "Failed to fetch (ExtensionOperationError: API capability denied: t3.browser/sessions)",
);

/** Every call is refused; the sessions stream is refused for its grant. */
function deniedHost() {
  const hang = (signal) =>
    new Promise((resolve) =>
      signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
    );
  return {
    React,
    invokeApi: async () => {
      throw new Error("API unavailable");
    },
    subscribeApi: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        if (request.id === "t3.browser/sessions") throw DENIAL;
        await hang(signal);
      },
    }),
  };
}

function session() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    context: {
      client: "web",
      resource: {
        namespace: "t3.browser",
        id: "view",
        environmentId: "env-a",
        projectId: "project-a",
        threadId: "thread-a",
      },
    },
    visible: true,
    restoreState: null,
    save() {},
    onVisibility: () => () => {},
    bindCommands: () => () => {},
  };
}

const textOf = (node) =>
  typeof node === "string" ? node : (node?.children ?? []).map(textOf).join("");

NodeTest.test("a denied sessions stream names the permission and where to grant it", async () => {
  const view = session();
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(bundle.BrowserView, { host: deniedHost(), session: view }),
    );
  });
  try {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    const status = renderer.root.find(
      (node) => node.type === "div" && node.props["aria-label"] === "Browser status",
    );
    NodeAssert.equal(
      textOf(status),
      "Browser sessions are unavailable — Needs permission t3.browser/sessions. Grant it in Settings → Extensions.",
    );
  } finally {
    await act(async () => {
      view.controller.abort();
      renderer.unmount();
    });
  }
});
