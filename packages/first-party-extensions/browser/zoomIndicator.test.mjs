/**
 * The zoom pill over the REAL pageMenu.tsx, bundled by esbuild into the
 * system tmpdir and rendered with react-test-renderer.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { BROWSER_SURFACE_Z_INDEX } from "@t3tools/extension-sdk/catalogue";

import { floatingLayers } from "./floating.ts";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let ZoomIndicator;

NodeTest.before(async () => {
  const built = await build({
    entryPoints: [NodePath.join(packageDir, "pageMenu.tsx")],
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
  const bundleDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-zoom-pill-"));
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    ({ ZoomIndicator } = await import(NodeURL.pathToFileURL(bundlePath).href));
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

NodeTest.it("the zoom pill stays in the page area, under the host's page menu layer", () => {
  const layers = floatingLayers(BROWSER_SURFACE_Z_INDEX + 1);
  // A host floating layer is available, as on web and desktop; the page menu uses it.
  const HostLayer = ({
    anchor: _anchor,
    elementRef: _ref,
    side: _side,
    offset: _offset,
    ...rest
  }) => React.createElement("div", { ...rest, "data-host-floating-layer": "" });
  const props = (zoomFactor) => ({
    zoomFactor,
    anchor: {},
    floating: { Popover: HostLayer, style: {} },
    zIndex: layers.transient,
    style: {},
    visible: true,
  });
  let renderer;
  act(() => {
    renderer = create(React.createElement(ZoomIndicator, props(1)));
  });
  act(() => renderer.update(React.createElement(ZoomIndicator, props(1.1))));
  const pill = renderer.root.find(
    (node) => node.type === "div" && node.props["aria-label"] === "Page zoom",
  );
  // In the host's layer the pill would paint over an open page menu (native's never does).
  NodeAssert.equal(pill.props["data-host-floating-layer"], undefined);
  NodeAssert.equal(pill.props.style.position, "absolute");
  NodeAssert.equal(pill.props.style.zIndex, layers.transient);
  NodeAssert.ok(layers.transient > BROWSER_SURFACE_Z_INDEX);
  act(() => renderer.unmount());
});
