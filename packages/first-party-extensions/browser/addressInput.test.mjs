/**
 * Escape in the address field over the REAL addressInput.tsx, bundled by
 * esbuild into the system tmpdir and driven with react-test-renderer under a
 * host that owns the draft like the panel does.
 */
import * as NodeAssert from "node:assert/strict";
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

let AddressInput;
let committedAddress;

NodeTest.before(async () => {
  const built = await build({
    entryPoints: [NodePath.join(packageDir, "addressInput.tsx")],
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
  const bundleDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-address-input-"));
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    ({ AddressInput, committedAddress } = await import(NodeURL.pathToFileURL(bundlePath).href));
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

/**
 * Mounts the field under a host that owns the draft like the panel and
 * whose committed address can move (guest navigation, redirects, history).
 */
function mountAddress(initial) {
  const submits = [];
  let committed = initial;
  let value = initial;
  let renderer;
  const render = () =>
    React.createElement(AddressInput, {
      value,
      committed,
      onValueChange: (next) => {
        value = next;
        renderer.update(render());
      },
      onSubmit: (next) => submits.push(next),
      inputRef: null,
      style: {},
    });
  act(() => {
    renderer = create(render());
  });
  const input = () => renderer.root.find((node) => node.props["aria-label"] === "Address");
  /** The DOM field's selection, as `select()` leaves it. */
  const field = {
    selection: null,
    select() {
      field.selection = [0, value.length];
    },
  };
  return {
    selection: () => field.selection,
    submits,
    value: () => input().props.value,
    /** The page the session shows changes without the field's involvement. */
    navigate(next) {
      committed = next;
      act(() => renderer.update(render()));
    },
    focus() {
      act(() => input().props.onFocus?.({ currentTarget: field }));
    },
    blur() {
      act(() => input().props.onBlur?.({}));
    },
    type(next) {
      act(() => input().props.onChange({ target: { value: next } }));
    },
    key(key) {
      const event = {
        key,
        blurred: false,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        currentTarget: {
          blur() {
            event.blurred = true;
            input().props.onBlur?.({});
          },
        },
      };
      act(() => input().props.onKeyDown(event));
      return event;
    },
  };
}

NodeTest.describe("address field focus", () => {
  NodeTest.it("selects the whole address, so typing replaces it", async () => {
    const address = mountAddress("http://127.0.0.1:47952/b");
    address.focus();
    // Native selects after the focus settles; so does the field.
    await Promise.resolve();
    NodeAssert.deepEqual(address.selection(), [0, "http://127.0.0.1:47952/b".length]);
  });
});

NodeTest.describe("address field keys", () => {
  NodeTest.it("Escape cancels the edit: the draft returns to the page and focus leaves", () => {
    const address = mountAddress("https://example.com/");
    address.focus();
    address.type("https://exam");
    const escape = address.key("Escape");
    NodeAssert.equal(address.value(), "https://example.com/");
    NodeAssert.equal(escape.blurred, true);
    NodeAssert.equal(escape.defaultPrevented, true);
    NodeAssert.deepEqual(address.submits, []);
  });

  NodeTest.it("Enter submits the draft", () => {
    const address = mountAddress("https://example.com/");
    address.focus();
    address.type("localhost:3000");
    address.key("Enter");
    NodeAssert.deepEqual(address.submits, ["localhost:3000"]);
  });

  NodeTest.it("Enter leaves the field, which then shows where a redirect lands", () => {
    const address = mountAddress("https://example.com/");
    address.focus();
    address.type("localhost:3000");
    const enter = address.key("Enter");
    NodeAssert.equal(enter.blurred, true);
    NodeAssert.equal(enter.defaultPrevented, true);
    address.navigate("http://localhost:3000/landing");
    NodeAssert.equal(address.value(), "http://localhost:3000/landing");
  });

  NodeTest.it("Enter submits the trimmed draft; a blank one submits nothing and stays", () => {
    const address = mountAddress("https://example.com/");
    address.focus();
    address.type("  localhost:3000  ");
    address.key("Enter");
    NodeAssert.deepEqual(address.submits, ["localhost:3000"]);
    address.focus();
    address.type("   ");
    const enter = address.key("Enter");
    NodeAssert.deepEqual(address.submits, ["localhost:3000"]);
    NodeAssert.equal(enter.blurred, false);
    NodeAssert.equal(address.value(), "   ");
  });

  NodeTest.it("follows guest navigation, redirects and history while unfocused", () => {
    const address = mountAddress("https://a.test/");
    address.navigate("https://b.test/");
    NodeAssert.equal(address.value(), "https://b.test/");
    // A redirect, then Back: each lands in the field, as native's `url` does.
    address.navigate("https://b.test/landing");
    NodeAssert.equal(address.value(), "https://b.test/landing");
    address.navigate("https://a.test/");
    NodeAssert.equal(address.value(), "https://a.test/");
  });

  NodeTest.it("starts an edit from the page shown now, not an older one", () => {
    const address = mountAddress("https://a.test/");
    address.navigate("https://b.test/");
    address.focus();
    NodeAssert.equal(address.value(), "https://b.test/");
    address.key("Enter");
    NodeAssert.deepEqual(address.submits, ["https://b.test/"]);
  });

  NodeTest.it("keeps the user's draft while the page navigates under the edit", () => {
    const address = mountAddress("https://a.test/");
    address.focus();
    address.type("https://typed.test/");
    address.navigate("https://b.test/");
    NodeAssert.equal(address.value(), "https://typed.test/");
  });

  NodeTest.it("shows the page again once the field loses focus without submitting", () => {
    const address = mountAddress("https://a.test/");
    address.focus();
    address.type("https://unsent.test/");
    address.blur();
    NodeAssert.equal(address.value(), "https://a.test/");
    address.navigate("https://b.test/");
    NodeAssert.equal(address.value(), "https://b.test/");
    NodeAssert.deepEqual(address.submits, []);
  });

  NodeTest.it("Escape returns to the page shown now after it navigated mid-edit", () => {
    const address = mountAddress("https://a.test/");
    address.focus();
    address.type("https://typed.test/");
    address.navigate("https://b.test/");
    address.key("Escape");
    NodeAssert.equal(address.value(), "https://b.test/");
    address.navigate("https://c.test/");
    NodeAssert.equal(address.value(), "https://c.test/");
  });

  NodeTest.it("returns to the file on show, then the page, then the target", () => {
    NodeAssert.equal(
      committedAddress({ fileSource: "docs/a.html", pageUrl: "http://lease/x", target: "t" }),
      "docs/a.html",
    );
    NodeAssert.equal(
      committedAddress({ fileSource: null, pageUrl: "https://a.test/", target: "https://b.test/" }),
      "https://a.test/",
    );
    NodeAssert.equal(committedAddress({ fileSource: null, pageUrl: null, target: null }), "");
  });
});
