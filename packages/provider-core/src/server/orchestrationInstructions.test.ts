import { assert, describe, it } from "@effect/vitest";

import { t3AcpPromptWithInstructions } from "./orchestrationInstructions.ts";

describe("t3AcpPromptWithInstructions", () => {
  it("sends the mode rules again only when the state changes", () => {
    const state = { interactionMode: "default", hasT3Mcp: true } as const;
    const first = t3AcpPromptWithInstructions({ prompt: "Check the login screen.", state });
    assert.include(first, "## T3 Code interaction mode: Default");
    assert.include(first, "<user_request>\nCheck the login screen.\n</user_request>");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt: "Plan it.",
        state: { ...state, interactionMode: "plan" },
        previousState: state,
      }),
      "## T3 Code interaction mode: Plan",
    );
  });
});
