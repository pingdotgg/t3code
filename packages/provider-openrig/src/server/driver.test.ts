import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OpenRigSettings } from "../settings.ts";
import { buildOpenRigAcpSpawnInput, openRigAcpServeArgs } from "./acpSupport.ts";

const decodeSettings = Schema.decodeUnknownSync(OpenRigSettings);

describe("OpenRigDriver", () => {
  it("launches rig acp serve from the configured binary", () => {
    assert.deepEqual(openRigAcpServeArgs(decodeSettings({})), ["acp", "serve"]);
    assert.deepEqual(buildOpenRigAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "rig",
      args: ["acp", "serve"],
      cwd: "/work",
    });
    const custom = buildOpenRigAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/openrig/bin/rig" }),
      "/work",
      { OPENRIG_HOME: "/tmp/rig-home" },
    );
    assert.equal(custom.command, "/opt/openrig/bin/rig");
    assert.deepEqual(custom.args, ["acp", "serve"]);
    assert.deepEqual(custom.env, { OPENRIG_HOME: "/tmp/rig-home" });
  });

  it("passes --to when a target member is configured", () => {
    assert.deepEqual(openRigAcpServeArgs(decodeSettings({ targetMember: "lead@rig" })), [
      "acp",
      "serve",
      "--to",
      "lead@rig",
    ]);
    assert.deepEqual(
      buildOpenRigAcpSpawnInput(decodeSettings({ targetMember: "  lead@rig  " }), "/work").args,
      ["acp", "serve", "--to", "lead@rig"],
    );
  });
});
