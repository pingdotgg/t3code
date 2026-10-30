import { describe, expect, it } from "vite-plus/test";

import { pickTriageEnvironment } from "./triageTarget";

describe("pickTriageEnvironment", () => {
  it("triages the machine on screen", () => {
    expect(
      pickTriageEnvironment({
        onScreen: "laptop",
        connected: ["desktop", "laptop"],
        supportsTriage: () => true,
      }),
    ).toBe("laptop");
  });

  it("with nothing on screen, skips connected machines whose server lacks triage", () => {
    expect(
      pickTriageEnvironment({
        onScreen: null,
        connected: ["old-server", "new-server"],
        supportsTriage: (environmentId) => environmentId === "new-server",
      }),
    ).toBe("new-server");
  });
});
