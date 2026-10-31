import { expect, it } from "vite-plus/test";

import { parseBenchmarkVariants } from "./refresh-model-benchmarks.ts";

it("keeps usable variants when a bundle contains overflowing or invalid scores", () => {
  const bundle = [
    "const variants=[",
    "{id:`first`,family:`test-model`,effort:`high`,intelligence:10,cost:2},",
    "{id:`overflow-cost`,family:`test-cost`,effort:`high`,intelligence:10,cost:1e309},",
    "{id:`overflow-score`,family:`test-score`,effort:`high`,intelligence:1e309,cost:1},",
    "{id:`negative`,family:`test-negative`,effort:`high`,intelligence:10,cost:-1},",
    "{id:`missing`,family:`test-missing`,effort:`high`,cost:1},",
    "{id:`latest`,family:`test-model`,effort:`high`,intelligence:11.123,cost:1.12345}",
    "]",
  ].join("");

  expect(parseBenchmarkVariants(bundle)).toEqual([
    { model: "test-model", effort: "high", intelligence: 11.12, costPerTask: 1.123 },
  ]);
});
