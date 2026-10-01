import { describe, expect, it } from "vite-plus/test";

import shippedLicense from "../assets/libghostty-vt-LICENSE.txt?raw";
import shippedVersion from "../assets/libghostty-vt-VERSION.txt?raw";
import pinnedLicense from "../../../native/libghostty-vt/LICENSE?raw";
import pinnedVersion from "../../../native/libghostty-vt/VERSION?raw";

describe("shipped libghostty-vt notices", () => {
  // Hosts that redistribute assets/ carry these copies next to the WASM; the
  // pin and license live canonically in native/libghostty-vt.
  it("match the canonical pin and license", () => {
    expect(shippedVersion).toBe(pinnedVersion);
    expect(shippedLicense).toBe(pinnedLicense);
  });
});
