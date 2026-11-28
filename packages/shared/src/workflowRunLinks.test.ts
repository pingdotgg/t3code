import { describe, expect, it } from "vite-plus/test";

import { parseWorkflowRunHref } from "./workflowRunLinks.ts";

describe("parseWorkflowRunHref", () => {
  it("rejects a whitespace-only environment id", () => {
    expect(parseWorkflowRunHref("/workflows?env=%20&run=run-1")).toBe("invalid-environment");
  });

  it("preserves nonblank ids after URL decoding", () => {
    expect(parseWorkflowRunHref("/workflows?env=%20env%3A1%20&run=run%2F1")).toEqual({
      env: " env:1 ",
      run: "run/1",
    });
  });
});
