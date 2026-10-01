import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { Tooltip } from "../dist/authoring.js";
import { resolveTooltip } from "../dist/environment.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A host tooltip that tags its trigger, so a render shows whether it ran.
const HostTooltip = (props) =>
  React.createElement("span", { "data-tip": props.label }, props.children);

/** Renders `Tooltip` around a disabled button; returns the tree or the thrown error. */
function render(host) {
  let renderer;
  try {
    act(() => {
      renderer = create(
        React.createElement(
          Tooltip,
          { host, label: "Back" },
          React.createElement("button", { id: "go", disabled: true }, "Go"),
        ),
      );
    });
  } catch (error) {
    return { error };
  }
  const tree = renderer.toJSON();
  act(() => renderer.unmount());
  return { tree };
}

const malformed = [
  ["null", null],
  ["a string", "tooltip"],
  ["version 0", { version: 0, Tooltip: HostTooltip }],
  ["a string version", { version: "1", Tooltip: HostTooltip }],
  ["a fractional version", { version: 1.5, Tooltip: HostTooltip }],
  ["an infinite version", { version: Infinity, Tooltip: HostTooltip }],
  ["no component", { version: 1 }],
  ["an intrinsic tag", { version: 1, Tooltip: "span" }],
  ["an untagged object", { version: 1, Tooltip: {} }],
  ["an arbitrary marker", { version: 1, Tooltip: { $$typeof: "not-a-react-type" } }],
  ["an element", { version: 1, Tooltip: React.createElement("span") }],
  ["a memo without a type", { version: 1, Tooltip: { $$typeof: Symbol.for("react.memo") } }],
  [
    "a memo around an element",
    { version: 1, Tooltip: { $$typeof: Symbol.for("react.memo"), type: React.createElement("i") } },
  ],
  [
    "a forwardRef without render",
    { version: 1, Tooltip: { $$typeof: Symbol.for("react.forward_ref") } },
  ],
  ["a lazy component", { version: 1, Tooltip: React.lazy(() => new Promise(() => {})) }],
];

NodeTest.describe("resolveTooltip", () => {
  NodeTest.it("is null on hosts without the member", () => {
    NodeAssert.equal(resolveTooltip({}), null);
    NodeAssert.equal(resolveTooltip({ tooltip: undefined }), null);
  });

  NodeTest.it(
    "accepts integer versions from 1 with function, memo and forwardRef components",
    () => {
      const forwarded = React.forwardRef((props, ref) =>
        React.createElement("span", { ref, "data-tip": props.label }, props.children),
      );
      for (const tooltip of [
        { version: 1, Tooltip: HostTooltip },
        { version: 2, Tooltip: HostTooltip, rich: true },
        { version: 1, Tooltip: React.memo(HostTooltip) },
        { version: 1, Tooltip: forwarded },
        { version: 1, Tooltip: React.memo(forwarded) },
      ])
        NodeAssert.equal(resolveTooltip({ tooltip }), tooltip);
    },
  );

  NodeTest.it("rejects malformed members", () => {
    for (const [name, tooltip] of malformed)
      NodeAssert.equal(resolveTooltip({ tooltip }), null, name);
  });
});

NodeTest.describe("Tooltip", () => {
  NodeTest.it("renders through real memo and forwardRef host components", () => {
    const forwarded = React.forwardRef((props, ref) =>
      React.createElement("span", { ref, "data-tip": props.label }, props.children),
    );
    for (const Component of [React.memo(HostTooltip), forwarded, React.memo(forwarded)]) {
      const { tree, error } = render({ React, tooltip: { version: 1, Tooltip: Component } });
      NodeAssert.equal(error, undefined);
      NodeAssert.equal(tree.props["data-tip"], "Back");
      NodeAssert.equal(tree.children[0].props.id, "go");
    }
  });

  NodeTest.it("falls back to the usable trigger for every malformed member", () => {
    for (const [name, tooltip] of [["absent", undefined], ...malformed]) {
      const { tree, error } = render({ React, tooltip });
      NodeAssert.equal(error, undefined, `${name} threw: ${error?.message}`);
      NodeAssert.equal(tree.type, "button", name);
      NodeAssert.equal(tree.props.id, "go", name);
      NodeAssert.deepEqual(tree.children, ["Go"], name);
    }
  });
});
