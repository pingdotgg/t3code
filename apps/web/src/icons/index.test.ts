/* eslint-disable no-restricted-imports -- the identity test compares the barrel with Lucide itself. */
import * as lucide from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import * as barrel from "./index";

describe("icon barrel", () => {
  it("re-exports every icon as the exact Lucide component", () => {
    const names = Object.keys(barrel);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        Object.is(barrel[name as keyof typeof barrel], lucide[name as keyof typeof lucide]),
        `~/icons export ${name} must be reference-identical to lucide-react's`,
      ).toBe(true);
    }
  });
});
