import { describe, expect, it } from "vite-plus/test";

import { nondeterministic, renderComparison } from "./render-metrics.ts";

describe("nondeterministic", () => {
  it("names only the scenarios whose counts differ between runs", () => {
    const stable = { commits: 2, renders: 10, components: { Row: 10 } };
    expect(
      nondeterministic([
        { mount: stable, type: { commits: 1, renders: 4, components: { Editor: 4 } } },
        { mount: stable, type: { commits: 1, renders: 5, components: { Editor: 5 } } },
      ]),
    ).toEqual(["type"]);
  });
});

describe("renderComparison", () => {
  it("prints per-scenario deltas and the components that moved most", () => {
    const output = renderComparison(
      { stream: { commits: 40, renders: 400, components: { Row: 300, Header: 100 } } },
      { stream: { commits: 30, renders: 250, components: { Row: 150, Header: 100 } } },
    );
    expect(output).toContain("| stream | 40 → 30 (-10, -25%) | 400 → 250 (-150, -37%) |");
    expect(output).toContain("| `Row` | 300 → 150 (-150, -50%) |");
    expect(output).not.toContain("`Header`");
  });
});
