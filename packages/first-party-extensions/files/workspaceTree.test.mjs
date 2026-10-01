import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import { useMutationRefresh, useWorkspaceChanges } from "./mutationRefresh.ts";
import { TREE_DISCONNECTED_STATUS, useWorkspaceTree } from "./workspaceTree.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

const session = {
  context: {
    resource: {
      namespace: "t3.extensions",
      id: "t3.files",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
    },
    client: "web",
    workspaceRevision: "rev",
  },
  signal: new AbortController().signal,
  restoring: false,
  visible: true,
  onVisibility: () => () => {},
  restoreState: null,
  publish: () => true,
  save: () => true,
  invoke: () => Promise.reject(new Error("no capabilities")),
  onDispose: () => {},
};

/** Settles every pending promise chain; no timers are involved. */
const flush = () => new Promise(setImmediate);

/**
 * A web-like host. While the transport is down it holds every outbound call
 * (a tree request neither runs nor fails) and, for a resumed changes stream,
 * reports the wait through `onSuspended`. The changes stream can be opened
 * either way, so hooks that never ask for resumption run here too.
 */
function makeHost(options = {}) {
  const treeSubscribes = [];
  let entries = [{ path: "a.ts", kind: "file" }];
  let online = true;
  let reconnect = () => {};
  let reconnected = Promise.resolve();
  let changes = null;
  const openChanges = (signal, onSuspended) => {
    const queue = [];
    let wake = null;
    changes = {
      push(value) {
        if (!online) {
          online = true;
          reconnect();
        }
        queue.push(value);
        wake?.();
      },
      suspend() {
        online = false;
        reconnected = new Promise((resolve) => (reconnect = resolve));
        onSuspended?.();
      },
    };
    return (async function* () {
      while (!signal.aborted) {
        if (queue.length === 0)
          await new Promise((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", resolve, { once: true });
          });
        while (queue.length > 0) yield { value: queue.shift() };
      }
    })();
  };
  const host = {
    subscribeApi(request, signal) {
      if (request.id === "t3.workspace/changes") return openChanges(signal);
      NodeAssert.equal(request.id, "t3.workspace/tree");
      treeSubscribes.push(request);
      return (async function* () {
        if (!online)
          await Promise.race([
            reconnected,
            new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
          ]);
        if (signal.aborted) return;
        const snapshot = entries;
        yield { value: { kind: "chunk", entries: snapshot, truncated: false } };
        yield { value: { kind: "complete", entryCount: snapshot.length, truncated: false } };
      })();
    },
    resumableStreams: {
      version: 3,
      subscribeApi(request, signal, streamOptions) {
        NodeAssert.equal(`${request.id}#${request.name}`, "t3.workspace/changes#subscribeChanges");
        return openChanges(signal, streamOptions.onSuspended);
      },
    },
    ...(options.label ? { environmentLabel: () => options.label } : {}),
  };
  return {
    host,
    treeSubscribes,
    setEntries: (next) => (entries = next),
    changes: () => changes,
  };
}

/** FilesView's composition: changes stream, tree, and mutation refresh. */
async function mountFiles(harness) {
  const view = { tree: null };
  function Probe() {
    const changes = useWorkspaceChanges(harness.host, session, true);
    const tree = useWorkspaceTree(harness.host, session, true, changes);
    useMutationRefresh({
      mutationSeq: changes.mutationSeq,
      enabled: true,
      refresh: tree.refresh,
      resumed: changes.resumed,
    });
    view.tree = tree;
    return null;
  }
  let root;
  await act(async () => {
    root = create(e(Probe, {}));
    await flush();
  });
  view.step = (action) =>
    act(async () => {
      action();
      await flush();
    });
  view.unmount = () => act(async () => root.unmount());
  return view;
}

const paths = (tree) => tree.entries.map((entry) => entry.path);

NodeTest.describe("Files tree while the environment is disconnected", () => {
  NodeTest.it(
    "says the environment is not connected instead of loading, and reloads once on reconnect",
    async () => {
      const harness = makeHost({ label: "Laptop" });
      const view = await mountFiles(harness);
      try {
        await view.step(() => harness.changes().push({ kind: "snapshot", mutationSeq: 0 }));
        NodeAssert.equal(view.tree.status, "Files ready");
        NodeAssert.equal(harness.treeSubscribes.length, 1);

        // The transport drops, then the user presses Refresh.
        await view.step(() => harness.changes().suspend());
        await view.step(() => view.tree.refresh());
        NodeAssert.deepEqual(
          { status: view.tree.status, pending: view.tree.pending, entries: paths(view.tree) },
          { status: "Laptop is not connected.", pending: false, entries: ["a.ts"] },
        );
        NodeAssert.equal(harness.treeSubscribes.length, 1);

        // The connection returns with an unchanged seq: one reload, new entries.
        harness.setEntries([
          { path: "a.ts", kind: "file" },
          { path: "b.ts", kind: "file" },
        ]);
        await view.step(() => harness.changes().push({ kind: "snapshot", mutationSeq: 0 }));
        NodeAssert.deepEqual(
          { status: view.tree.status, entries: paths(view.tree) },
          { status: "Files ready", entries: ["a.ts", "b.ts"] },
        );
        NodeAssert.equal(harness.treeSubscribes.length, 2);
      } finally {
        await view.unmount();
      }
    },
  );

  NodeTest.it(
    "a reconnect whose snapshot also advances the mutation seq requests the tree once",
    async () => {
      const harness = makeHost();
      const view = await mountFiles(harness);
      try {
        await view.step(() => harness.changes().push({ kind: "snapshot", mutationSeq: 0 }));
        NodeAssert.equal(harness.treeSubscribes.length, 1);

        await view.step(() => harness.changes().suspend());
        // No label from this host: the generic line.
        NodeAssert.equal(view.tree.status, TREE_DISCONNECTED_STATUS);

        // An agent edited files while we were away.
        await view.step(() => harness.changes().push({ kind: "snapshot", mutationSeq: 1 }));
        NodeAssert.equal(view.tree.status, "Files ready");
        NodeAssert.equal(harness.treeSubscribes.length, 2);

        // A later mutation still refreshes as usual.
        await view.step(() =>
          harness.changes().push({
            kind: "mutation",
            mutationSeq: 2,
            kinds: ["file_change"],
            at: "2026-09-29T00:00:00Z",
          }),
        );
        NodeAssert.equal(harness.treeSubscribes.length, 3);
      } finally {
        await view.unmount();
      }
    },
  );
});
