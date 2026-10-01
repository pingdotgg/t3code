import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createElement, useState, useEffect } from "react";
import { create, act } from "react-test-renderer";
import { ExtensionSurface } from "../dist/react.js";
import { createExtensionHost } from "../dist/host.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
NodeTest.test(
  "React view retains interactive local state while hidden and resets on context replacement",
  async () => {
    const host = createExtensionHost({ authorize: () => true });
    let mounts = 0,
      unmounts = 0;
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts++;
        return () => {
          unmounts++;
        };
      }, []);
      return createElement("button", { onClick: () => setCount(count + 1) }, String(count));
    }
    host.register({
      manifest: {
        id: "example.react",
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          {
            id: "example.react/view",
            title: "Counter",
            placements: ["side-panel"],
            clients: ["web"],
            scope: "environment",
            capabilities: [],
            stateVersion: 1,
          },
        ],
      },
      surfaces: [
        {
          id: "example.react/view",
          validateRestore: () => true,
          createView: () => ({ renderer: Counter }),
        },
      ],
    });
    const record = {
      version: 1,
      surfaceId: "example.react/view",
      context: {
        resource: { namespace: "example.react", id: "one", environmentId: "a" },
        client: "web",
      },
      placement: "side-panel",
      stateVersion: 1,
      restoreState: null,
      fallback: "Unavailable",
    };
    const id = await host.open(record);
    let tree;
    await act(async () => {
      tree = create(
        createElement(ExtensionSurface, {
          host,
          viewId: id,
          className: "host-layout",
          style: { height: "100%", display: "flex", minHeight: 0 },
        }),
      );
    });
    await act(async () => tree.root.findByType("button").props.onClick());
    NodeAssert.deepEqual(tree.root.findByType("button").children, ["1"]);
    await act(async () => host.hide(id));
    const hiddenWrapper = tree.root.findAllByType("div")[0];
    NodeAssert.equal(hiddenWrapper.props.hidden, true);
    NodeAssert.deepEqual(hiddenWrapper.props.style, {
      height: "100%",
      display: "none",
      minHeight: 0,
    });
    NodeAssert.deepEqual(tree.root.findByType("button").children, ["1"]);
    await act(async () => host.show(id));
    const visibleWrapper = tree.root.findAllByType("div")[0];
    NodeAssert.equal(visibleWrapper.props.hidden, false);
    NodeAssert.deepEqual(visibleWrapper.props.style, {
      height: "100%",
      display: "flex",
      minHeight: 0,
    });
    NodeAssert.deepEqual(tree.root.findByType("button").children, ["1"]);
    NodeAssert.equal(mounts, 1);
    NodeAssert.equal(unmounts, 0);
    await act(async () => host.updateContext(id, { ...record.context, workspaceRevision: "2" }));
    NodeAssert.deepEqual(tree.root.findByType("button").children, ["0"]);
    NodeAssert.equal(mounts, 2);
    NodeAssert.equal(unmounts, 1);
    await act(async () => host.close(id));
    NodeAssert.equal(unmounts, 2);
    NodeAssert.equal(tree.root.findAllByType("div")[0].props.style.height, "100%");
    await act(async () => tree.unmount());
    NodeAssert.equal(host.diagnostics().listeners, 0);
    host.dispose();
  },
);
