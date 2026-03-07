import { describe, expect, it } from "vitest";

import {
  formatCompactTokenCount,
  resolveContextWindowSeverity,
} from "./ContextWindowIndicator.logic";

describe("ContextWindowIndicator helpers", () => {
  it("formats compact token counts using lowercase suffixes", () => {
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(1_250)).toBe("1.3k");
    expect(formatCompactTokenCount(119_000)).toBe("119k");
    expect(formatCompactTokenCount(1_250_000)).toBe("1.3m");
  });

  it("maps usage thresholds to display severities", () => {
    expect(resolveContextWindowSeverity(46)).toBe("default");
    expect(resolveContextWindowSeverity(70)).toBe("warning");
    expect(resolveContextWindowSeverity(90)).toBe("danger");
  });
});
