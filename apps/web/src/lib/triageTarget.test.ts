import { describe, expect, it } from "vite-plus/test";

import { pickTriageEnvironment } from "./triageTarget";

describe("pickTriageEnvironment", () => {
  it("skips a primary machine whose server lacks triage", () => {
    expect(
      pickTriageEnvironment({
        onScreen: null,
        primary: "old-primary",
        connected: ["old-primary", "new-remote"],
        supportsTriage: (environmentId) => environmentId === "new-remote",
      }),
    ).toBe("new-remote");
  });

  it("prefers a capable primary over other capable machines", () => {
    expect(
      pickTriageEnvironment({
        onScreen: null,
        primary: "primary",
        connected: ["remote", "primary"],
        supportsTriage: () => true,
      }),
    ).toBe("primary");
  });
});
