import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import { create, act } from "react-test-renderer";
import createExtension from "../examples/installable-terminal-live-output/client.mjs";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
  const subscriptions = [];
  const context = {
    resource: {
      namespace: "example.terminal-live-output",
      id: "view",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
    },
    client: "test",
  };
  const session = { context, signal: new AbortController().signal };
  const host = {
    React,
    subscribeApi(request, signal) {
      let resolve,
        returned = 0;
      const pull = () =>
        new Promise((next) => {
          resolve = next;
        });
      const item = {
        request,
        signal,
        send: (frame) => resolve({ done: false, value: frame }),
        returned: () => returned,
      };
      subscriptions.push(item);
      return {
        [Symbol.asyncIterator]: () => ({
          next: pull,
          return: async () => {
            returned++;
            return { done: true, value: undefined };
          },
        }),
      };
    },
  };
  const Renderer = createExtension(host).surfaces[0].createView(session).renderer;
  return { subscriptions, context, Renderer };
}
const snapshot = (terminalId, contents) => ({
  streamId: "stream",
  sequence: 1,
  type: "snapshot",
  value: {
    kind: "snapshot",
    terminalId,
    streamEpoch: "epoch",
    status: "running",
    boundarySequence: 0,
    contents,
    retainedByteLength: contents.length,
    truncated: false,
    clearGeneration: 0,
    contentsUnitStart: 0,
  },
});
NodeTest.test(
  "actual independent client cancels replaced input and suppresses a late old subscription",
  async () => {
    const f = harness();
    let tree;
    await act(async () => {
      tree = create(React.createElement(f.Renderer));
    });
    await act(async () => {
      void tree.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const first = f.subscriptions[0];
    NodeAssert.equal(first.request.context, f.context);
    NodeAssert.equal(first.request.id, "example.terminal-live-output/events");
    await act(async () => {
      tree.root.findByType("input").props.onChange({ target: { value: "term-2" } });
    });
    NodeAssert.ok(first.signal.aborted);
    await act(async () => {
      void tree.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const second = f.subscriptions[1];
    await act(async () => {
      second.send(snapshot("term-2", "new output"));
    });
    await act(async () => {
      first.send(snapshot("term-1", "stale output"));
    });
    NodeAssert.equal(tree.root.findByType("pre").children.join(""), "new output");
    NodeAssert.equal(first.returned(), 1);
    await act(async () => {
      tree.root.findAllByType("button")[1].props.onClick();
    });
    NodeAssert.ok(second.signal.aborted);
    NodeAssert.equal(tree.root.findByType("pre").children.join(""), "");
    await act(async () => {
      second.send({ ...snapshot("term-2", "stale after stop"), sequence: 2 });
    });
    NodeAssert.equal(second.returned(), 1);
    await act(async () => {
      tree.unmount();
    });
  },
);
NodeTest.test(
  "actual client closes malformed streams and unmount aborts pending subscriptions",
  async () => {
    const f = harness();
    let tree;
    await act(async () => {
      tree = create(React.createElement(f.Renderer));
    });
    await act(async () => {
      void tree.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const first = f.subscriptions[0];
    await act(async () => {
      first.send(snapshot("foreign-terminal", "must not display"));
    });
    NodeAssert.equal(tree.root.findByType("pre").children.join(""), "");
    NodeAssert.match(
      tree.root.findByProps({ role: "status" }).children.join(""),
      /terminal changed/,
    );
    NodeAssert.equal(first.returned(), 1);
    await act(async () => {
      void tree.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const second = f.subscriptions[1];
    await act(async () => {
      tree.unmount();
    });
    NodeAssert.ok(second.signal.aborted);
    await act(async () => {
      second.send(snapshot("term-1", "unmounted"));
    });
    NodeAssert.equal(second.returned(), 1);
  },
);
