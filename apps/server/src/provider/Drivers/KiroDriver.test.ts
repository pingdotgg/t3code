import { assert, describe, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { buildKiroAcpSpawnInput } from "../acp/KiroAcpSupport.ts";
import { kiroAuthFromWhoami } from "../Layers/KiroProvider.ts";
import { KiroDriver } from "./KiroDriver.ts";

const decodeSettings = Schema.decodeUnknownSync(KiroSettings);

describe("KiroDriver", () => {
  it("is a built-in driver that starts disabled", () => {
    assert.isTrue(BUILT_IN_DRIVERS.includes(KiroDriver));
    assert.isFalse(KiroDriver.defaultConfig().enabled);
  });

  it("launches the V3 ACP engine with CLI-owned auth from the configured binary", () => {
    assert.deepEqual(buildKiroAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "kiro-cli",
      args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
      cwd: "/work",
    });
    const custom = buildKiroAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/kiro/bin/kiro-cli" }),
      "/work",
      { KIRO_API_KEY: "ksk_test" },
    );
    assert.equal(custom.command, "/opt/kiro/bin/kiro-cli");
    assert.deepEqual(custom.args, ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    assert.deepEqual(custom.env, { KIRO_API_KEY: "ksk_test" });
  });

  // Outputs recorded from `kiro-cli whoami --format json` on Kiro CLI 2.27.0.
  it("reads the sign-in state from kiro-cli whoami", () => {
    assert.deepEqual(kiroAuthFromWhoami({ code: 1, stdout: '{"account":null}\n' }, {}), {
      status: "unauthenticated",
    });
    assert.deepEqual(
      kiroAuthFromWhoami({ code: 0, stdout: '{"accountType":"ApiKey","email":null}\n' }, {}),
      { status: "authenticated", type: "api_key", label: "Kiro API key" },
    );
    assert.deepEqual(
      kiroAuthFromWhoami(
        { code: 0, stdout: '{"accountType":"BuilderId","email":"dev@example.com"}\n' },
        {},
      ),
      { status: "authenticated", label: "Kiro account", email: "dev@example.com" },
    );
    assert.deepEqual(kiroAuthFromWhoami({ code: 2, stdout: "error: service error" }, {}), {
      status: "unknown",
    });
    assert.deepEqual(kiroAuthFromWhoami(undefined, {}), { status: "unknown" });
  });
});
