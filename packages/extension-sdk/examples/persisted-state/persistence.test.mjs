import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";
import React from "react";
import TestRenderer from "react-test-renderer";
import { createExtensionHost } from "../../dist/host.js";

// Build a scratch copy of the example so the test consumes this run's
// build output, never a possibly stale committed bundle.
const here = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const scratch = await NodeFSP.mkdtemp(NodePath.join(here, ".t3-extension-build-test-"));
try {
  for (const entry of await NodeFSP.readdir(here)) {
    if (
      entry.startsWith(".t3-extension") ||
      entry === "node_modules" ||
      entry.endsWith(".test.mjs")
    )
      continue;
    await NodeFSP.cp(NodePath.join(here, entry), NodePath.join(scratch, entry), {
      recursive: true,
    });
  }
  // The example's own package.json is the nearest one for module
  // resolution, and it has no local node_modules: give the scratch copy the
  // same link layout an install would produce so the build resolves the
  // workspace SDK and react exactly as a consumer's install would.
  const sdk = NodePath.resolve(here, "../..");
  await NodeFSP.mkdir(NodePath.join(scratch, "node_modules", "@t3tools"), { recursive: true });
  await NodeFSP.symlink(sdk, NodePath.join(scratch, "node_modules", "@t3tools", "extension-sdk"));
  await NodeFSP.symlink(
    NodePath.join(sdk, "node_modules", "react"),
    NodePath.join(scratch, "node_modules", "react"),
  );
  const cli = NodeURL.fileURLToPath(new URL("../../bin/t3-extension.mjs", import.meta.url));
  const build = NodeChildProcess.spawnSync(process.execPath, [cli, "build", scratch], {
    encoding: "utf8",
  });
  NodeAssert.equal(build.status, 0, `t3-extension build failed:\n${build.stdout}\n${build.stderr}`);
} catch (error) {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
  throw error;
}
NodeTest.after(() => NodeFSP.rm(scratch, { recursive: true, force: true }));
const { default: clientFactory } = await import(
  NodeURL.pathToFileURL(NodePath.join(scratch, ".t3-extension/client.mjs")).href
);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The built client factory only reads host.React; the API bridges are unused.
const clientHost = {
  React,
  invokeApi: () => Promise.reject(new Error("no APIs in this example")),
  subscribeApi: () => {
    throw new Error("no APIs in this example");
  },
  discoverApis: () => Promise.resolve([]),
  invokeTool: () => Promise.reject(new Error("no tools in this example")),
};
const extension = clientFactory(clientHost);
const record = (restoreState = null) => ({
  version: 1,
  surfaceId: "example.persisted-state/view",
  context: {
    resource: {
      namespace: "example.persisted-state",
      id: "resource",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
    },
    client: "web",
  },
  placement: "side-panel",
  stateVersion: 1,
  restoreState,
  fallback: "Counter unavailable",
});
const mount = async (host, id) => {
  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      React.createElement(host.renderer(id), { snapshot: host.snapshot(id) }),
    );
  });
  return renderer;
};
const countText = (renderer) =>
  renderer.root.findByProps({ "aria-label": "Count" }).children.join("");

NodeTest.test("built client saves state and a reopened view restores it", async () => {
  const host = createExtensionHost({ authorize: () => true });
  host.register(extension);
  const first = await host.open(record());
  NodeAssert.equal(host.snapshot(first).status, "ready");
  const view = await mount(host, first);
  NodeAssert.equal(countText(view), "0");
  await TestRenderer.act(async () => {
    view.root.findByType("button").props.onClick();
  });
  NodeAssert.equal(countText(view), "1");
  const saved = host.snapshot(first).record;
  NodeAssert.deepEqual(saved.restoreState, { count: 1, label: "saved" });
  host.close(first);

  const second = await host.restore(saved);
  const reopened = await mount(host, second);
  NodeAssert.equal(countText(reopened), "1");
  host.dispose();
  NodeAssert.equal(host.diagnostics().views, 0);
});

NodeTest.test("schema-violating restore is unavailable with an actionable reason", async () => {
  const host = createExtensionHost({ authorize: () => true });
  host.register(extension);
  for (const [restoreState, pattern] of [
    [
      { count: "one" },
      /expected field "count" to be number, received string.*stateSchema.*stateVersion/s,
    ],
    [{ label: "x" }, /missing required field "count" \(number\).*received/s],
    [
      42,
      /expected null \(nothing saved yet\) or an object matching \{count: number, label\?: string\}; received 42/s,
    ],
  ]) {
    const id = await host.restore(record(restoreState));
    NodeAssert.equal(host.snapshot(id).status, "unavailable");
    NodeAssert.match(host.snapshot(id).reason, pattern);
    NodeAssert.match(host.snapshot(id).reason, /example\.persisted-state\/view/);
  }
  const mismatched = await host.restore({ ...record({ count: 1 }), stateVersion: 2 });
  NodeAssert.equal(host.snapshot(mismatched).status, "unavailable");
  NodeAssert.match(host.snapshot(mismatched).reason, /version is incompatible/);
  host.dispose();
});

NodeTest.test(
  "session.save rejects out-of-schema values with the same actionable error",
  async () => {
    const host = createExtensionHost({ authorize: () => true });
    let session;
    host.register({
      manifest: extension.manifest,
      surfaces: extension.surfaces.map((surface) => ({
        ...surface,
        createView(current) {
          session = current;
          return { renderer: () => null };
        },
      })),
    });
    await host.open(record());
    NodeAssert.throws(
      () => session.save({ count: "many" }),
      /Invalid restore state for "example\.persisted-state\/view" \(stateVersion 1\): expected field "count" to be number, received string.*Fix the value passed to session\.save/s,
    );
    host.dispose();
  },
);
