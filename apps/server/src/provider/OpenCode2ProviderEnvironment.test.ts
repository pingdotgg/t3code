// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";

import {
  applyOpenCode2ProviderEnvironment,
  OPENCODE2_BACKGROUND_SUBAGENTS_ENV,
  openCode2ManagedStateRoot,
} from "./OpenCode2ProviderEnvironment.ts";

describe("applyOpenCode2ProviderEnvironment", () => {
  it("explicitly enables background subagents for a managed server", () => {
    const env = applyOpenCode2ProviderEnvironment(
      { backgroundSubagents: true, serverUrl: "" },
      {
        OPENCODE_EXPERIMENTAL: "false",
        TMPDIR: "/tmp/t3-opencode2-env-test",
        [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "false",
      },
    );
    expect(env).toMatchObject({
      OPENCODE_EXPERIMENTAL: "false",
      [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: "true",
    });
    const root = openCode2ManagedStateRoot({ TMPDIR: "/tmp/t3-opencode2-env-test" });
    expect(env.XDG_STATE_HOME).toBe(NodePath.join(root, "state"));
    expect(env.XDG_DATA_HOME).toBe(NodePath.join(root, "data"));
    expect(env.XDG_CONFIG_HOME).toBe(NodePath.join(root, "config"));
  });

  it("explicitly disables background subagents even under the umbrella experiment", () => {
    expect(
      applyOpenCode2ProviderEnvironment(
        { backgroundSubagents: false, serverUrl: "" },
        { OPENCODE_EXPERIMENTAL: "true", TMPDIR: "/tmp/t3-opencode2-env-test-2" },
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
