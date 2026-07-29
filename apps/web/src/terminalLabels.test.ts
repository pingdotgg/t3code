import { describe, expect, it } from "vitest";

import { terminalLabelsById } from "./terminalLabels";

describe("terminalLabelsById", () => {
  it("preserves terminal labels when selecting an individual terminal surface", () => {
    expect(terminalLabelsById(["default", "terminal-a"])).toEqual({
      default: "Terminal 1",
      "terminal-a": "Terminal 2",
    });
  });
});
