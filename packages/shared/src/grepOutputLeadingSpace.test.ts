import { expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

it("keeps matches grouped when a ripgrep heading starts with a space", () => {
  const output = " release notes.txt\n2:needle\n";
  expect(parseGrepOutput(output, ".")?.[0]?.fileName).toBe(" release notes.txt");
});
