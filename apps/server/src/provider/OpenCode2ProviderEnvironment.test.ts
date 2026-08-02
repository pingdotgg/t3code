import { describe, expect, it } from "vite-plus/test";

import {
  applyOpenCode2ProviderEnvironment,
  OPENCODE2_BACKGROUND_SUBAGENTS_ENV,
} from "./OpenCode2ProviderEnvironment.ts";

describe("applyOpenCode2ProviderEnvironment", () => {
  it("explicitly enables background subagents for a managed server", () => {
    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: true, serverUrl: "" },
        {
          OPENCODE_EXPERIMENTAL: "false",
          [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
        },
      ),
    ).toMatchObject({
      OPENCODE_EXPERIMENTAL: "false",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "true",
    });
  });

  it("explicitly disables background subagents even under the umbrella experiment", () => {
    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: false, serverUrl: "" },
        { OPENCODE_EXPERIMENTAL: "true" },
      ),
    ).toMatchObject({
      OPENCODE_EXPERIMENTAL: "true",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
    });
  });

  it("does not claim control over an external server environment", () => {
    const environment = { [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "external" };

    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: true, serverUrl: " http://127.0.0.1:4096 " },
        environment,
      ),
    ).toBe(environment);
  });
});
