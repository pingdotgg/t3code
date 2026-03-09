import { describe, expect, it } from "vitest";
import { createOpenCodeHarnessAdapter } from "./opencode";

describe("createOpenCodeHarnessAdapter", () => {
  it("requires a baseUrl in the profile config", () => {
    const adapter = createOpenCodeHarnessAdapter();
    expect(() =>
      adapter.validateProfile({
        id: "profile-1" as never,
        name: "OpenCode",
        harness: "opencode",
        adapterFamily: "process",
        connectionMode: "spawned",
        enabled: true,
        config: {
          opencode: {},
        },
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
      }),
    ).toThrow(/baseUrl/);
  });
});
