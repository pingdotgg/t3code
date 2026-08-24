import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { copilotReviewRuntimeHandler } from "./CopilotReviewRuntime.ts";

describe("CopilotReviewRuntime", () => {
  it("advertises the review agent through the runtime info route", async () => {
    const response = await copilotReviewRuntimeHandler(
      new Request("http://localhost/api/copilotkit/info"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"review"');
  });
});
