import { assert, describe, it } from "@effect/vitest";

import { t3AcpPromptWithInstructions } from "./orchestrationInstructions.ts";

describe("t3AcpPromptWithInstructions", () => {
  it("adds the MCP fallback once, when the T3 tools are present", () => {
    const state = { hasT3Mcp: true } as const;
    const first = t3AcpPromptWithInstructions({ prompt: "Check the login screen.", state });
    assert.include(first, "ACP fallback:");
    assert.include(first, "<user_request>\nCheck the login screen.\n</user_request>");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
  });

  it("leaves the prompt alone without the T3 tools", () => {
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Check it.", state: { hasT3Mcp: false } }),
      "Check it.",
    );
  });
});
