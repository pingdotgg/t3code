import { describe, expect, it } from "vite-plus/test";

import { extractAgentContextFiles } from "./AgentPromptResolver.ts";

describe("extractAgentContextFiles", () => {
  it("extracts explicit composer links and element sources deterministically", () => {
    expect(
      extractAgentContextFiles(
        "Check [index.ts](src/index.ts) and [again](src/index.ts)\n  source: apps/web/Button.tsx:12:4",
      ),
    ).toEqual(["src/index.ts", "apps/web/Button.tsx"]);
  });

  it("rejects absolute and escaping paths", () => {
    expect(
      extractAgentContextFiles("[escape](../secret.txt) [absolute](C:%5CUsers%5Csecret.txt)"),
    ).toEqual([]);
  });
});
