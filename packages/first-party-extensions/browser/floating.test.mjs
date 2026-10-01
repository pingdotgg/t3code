import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  BROWSER_SURFACE_OVERLAY_ATTRIBUTE,
  BROWSER_SURFACE_Z_INDEX,
} from "@t3tools/extension-sdk/catalogue";

import { floatingLayers, floatingOverPage } from "./floating.ts";

NodeTest.test("floating panel UI stacks over the page, the menu over the device toolbar", () => {
  const layers = floatingLayers(BROWSER_SURFACE_Z_INDEX + 1);
  NodeAssert.ok(layers.deviceChrome > BROWSER_SURFACE_Z_INDEX);
  // An open page menu or zoom pill must never sit under the device toolbar.
  NodeAssert.ok(layers.transient > layers.deviceChrome);
});

NodeTest.test("floating panel UI carries the SDK's overlay marker", () => {
  NodeAssert.deepEqual(Object.keys(floatingOverPage), [BROWSER_SURFACE_OVERLAY_ATTRIBUTE]);
});
