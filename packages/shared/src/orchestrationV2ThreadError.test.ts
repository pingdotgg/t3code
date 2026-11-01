import { describe, expect, it } from "vite-plus/test";

import { providerFailurePresentation } from "./orchestrationV2ThreadError.ts";

describe("providerFailurePresentation", () => {
  it.each(["provider.rate-limit", "APIError"])(
    "recognizes an OpenCode %s admission refusal and replaces a legacy title",
    (code) => {
      expect(
        providerFailurePresentation(
          {
            class: "usage_limit",
            code,
            message:
              "Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 30 s)",
          },
          "Usage limit reached",
        ),
      ).toEqual({ kind: "provider_capacity", title: "Provider at capacity" });
    },
  );

  it("keeps true quota and ordinary rate-limit failures under the usage-limit title", () => {
    for (const failure of [
      {
        class: "usage_limit",
        code: "provider.quota",
        message: "Subscription quota exceeded.",
        retryable: null,
      },
      {
        class: "usage_limit",
        code: "provider.rate-limit",
        message: "Rate limit exceeded: free-models-per-min.",
        retryable: null,
      },
      {
        class: "usage_limit",
        code: "APIError",
        message: "Rate limit exceeded.",
        retryable: null,
      },
    ] as const) {
      expect(providerFailurePresentation(failure)).toEqual({
        kind: "usage_limit",
        title: "Usage limit reached",
      });
    }
  });
});
