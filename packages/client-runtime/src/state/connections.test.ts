import { describe, expect, it } from "@effect/vitest";

import { summarizeEnvironmentLabels } from "./connections.ts";

const named = (...labels: ReadonlyArray<string>) => labels.map((label) => ({ label }));

describe("summarizeEnvironmentLabels", () => {
  it("lists every name when there are only a few", () => {
    expect(summarizeEnvironmentLabels(named("laptop", "server"))).toBe("laptop, server");
  });

  it("names the first few and counts the rest", () => {
    expect(summarizeEnvironmentLabels(named("a", "b", "c", "d", "e"))).toBe("a, b, c and 2 more");
  });
});
