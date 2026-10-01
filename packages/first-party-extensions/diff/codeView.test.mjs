import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import { DiffFileBodies, diffRenderer, hostDiffProps } from "./codeView.ts";
import { renderableFromPatch } from "./viewModel.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "diff --git a/src/old.ts b/src/renamed.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to src/renamed.ts",
  "index 3333333..4444444 100644",
  "--- a/src/old.ts",
  "+++ b/src/renamed.ts",
  "@@ -3,1 +3,1 @@",
  "-before",
  "+after",
].join("\n");
const files = renderableFromPatch(PATCH).files;
const [a, renamed] = files;

function codeViewHost() {
  const received = [];
  const Diff = (props) => {
    received.push(props);
    return e("div", { "data-host-diff": true });
  };
  return { host: { codeView: { version: 1, Diff, File: () => null } }, received };
}

async function render(element) {
  let root;
  await act(async () => {
    root = create(element);
  });
  return root;
}

NodeTest.describe("diffRenderer", () => {
  NodeTest.it("keeps own rows on hosts without the member", () => {
    NodeAssert.deepEqual(diffRenderer({}, false), { kind: "rows", reason: "host-unavailable" });
  });

  NodeTest.it("keeps own rows for a malformed member", () => {
    NodeAssert.deepEqual(diffRenderer({ codeView: { version: 1, Diff: () => null } }, false), {
      kind: "rows",
      reason: "host-unavailable",
    });
  });

  NodeTest.it("uses the host view when offered, and own rows while commenting", () => {
    const { host } = codeViewHost();
    NodeAssert.equal(diffRenderer(host, false).kind, "host");
    NodeAssert.deepEqual(diffRenderer(host, true), { kind: "rows", reason: "commenting" });
  });
});

NodeTest.describe("DiffFileBodies", () => {
  const props = (renderer, calls) => ({
    renderer,
    renderHostProps: () => {
      calls.push("hostProps");
      return { patch: PATCH, layout: "unified", wordWrap: false };
    },
    renderRows: () => {
      calls.push("rows");
      return e("ol", { "data-own-rows": true });
    },
  });

  NodeTest.it("renders own rows and never builds host props without the member", async () => {
    const calls = [];
    const root = await render(e(DiffFileBodies, props(diffRenderer({}, false), calls)));
    NodeAssert.deepEqual(calls, ["rows"]);
    NodeAssert.equal(root.root.findAll((node) => node.props["data-own-rows"]).length, 1);
  });

  NodeTest.it("renders the host Diff with the patch when the member is present", async () => {
    const calls = [];
    const { host, received } = codeViewHost();
    const root = await render(e(DiffFileBodies, props(diffRenderer(host, false), calls)));
    NodeAssert.deepEqual(calls, ["hostProps"]);
    NodeAssert.equal(received.at(-1).patch, PATCH);
    NodeAssert.equal(root.root.findAll((node) => node.props["data-own-rows"]).length, 0);
  });
});

NodeTest.describe("hostDiffProps", () => {
  const base = (overrides = {}) => {
    const events = [];
    const props = hostDiffProps({
      patch: PATCH,
      files,
      collapsedKeys: new Set([renamed.key]),
      layout: "split",
      wrap: true,
      reveal: null,
      onToggleCollapsed: (key) => events.push(["toggle", key]),
      onFileAction: (action, row) => events.push([action, row.key]),
      ...overrides,
    });
    return { props, events };
  };

  NodeTest.it("names folded files by path and maps header callbacks back to row keys", () => {
    const { props, events } = base();
    NodeAssert.deepEqual(props.collapsedPaths, ["src/renamed.ts"]);
    NodeAssert.equal(props.layout, "split");
    NodeAssert.equal(props.wordWrap, true);
    props.onToggleCollapsed("src/a.ts");
    props.onFileAction("copy", "src/renamed.ts");
    props.onFileAction("open", "src/a.ts");
    props.onFileAction("delete", "src/a.ts");
    props.onToggleCollapsed("src/unknown.ts");
    NodeAssert.deepEqual(events, [
      ["toggle", a.key],
      ["copy", renamed.key],
      ["open", a.key],
    ]);
  });

  NodeTest.it("carries a reveal request by path, and drops one for a vanished file", () => {
    NodeAssert.deepEqual(base({ reveal: { key: renamed.key, requestId: 4 } }).props.reveal, {
      path: "src/renamed.ts",
      requestId: 4,
    });
    NodeAssert.equal(base({ reveal: { key: "gone", requestId: 5 } }).props.reveal, undefined);
  });

  NodeTest.it("offers context expansion only when the panel can load contents", async () => {
    NodeAssert.equal(base().props.loadContents, undefined);
    const loaded = [];
    const { props } = base({
      loadContents: async (row) => {
        loaded.push(row.key);
        return { oldContents: "old", newContents: "new" };
      },
    });
    NodeAssert.deepEqual(await props.loadContents("src/a.ts"), {
      oldContents: "old",
      newContents: "new",
    });
    await NodeAssert.rejects(props.loadContents("src/unknown.ts"), /not part of this diff/);
    NodeAssert.deepEqual(loaded, [a.key]);
  });
});
