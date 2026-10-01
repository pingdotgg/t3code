import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { resolveFloatingLayer } from "../dist/environment.js";

const Popover = () => null;

NodeTest.describe("resolveFloatingLayer", () => {
  NodeTest.it("is null on hosts without the member, so the plugin renders in place", () => {
    NodeAssert.equal(resolveFloatingLayer({}), null);
    NodeAssert.equal(resolveFloatingLayer({ floatingLayer: undefined }), null);
  });

  NodeTest.it("returns a version 1 or later member unchanged", () => {
    const v1 = { version: 1, Popover };
    NodeAssert.equal(resolveFloatingLayer({ floatingLayer: v1 }), v1);
    const v2 = { version: 2, Popover: { $$typeof: Symbol.for("react.memo") }, Tooltip: Popover };
    NodeAssert.equal(resolveFloatingLayer({ floatingLayer: v2 }), v2);
  });

  NodeTest.it("rejects malformed members instead of rendering them", () => {
    for (const floatingLayer of [
      null,
      "layer",
      { version: 0, Popover },
      { version: "1", Popover },
      { version: 1 },
      { version: 1, Popover: "div" },
      { version: 1, Popover: {} },
    ])
      NodeAssert.equal(
        resolveFloatingLayer({ floatingLayer }),
        null,
        JSON.stringify(floatingLayer),
      );
  });
});
