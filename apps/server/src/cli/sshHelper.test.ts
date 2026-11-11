import { assert, it } from "@effect/vitest";

import { keepsRunningServer } from "./sshHelper.ts";

const runtime = (fields: Record<string, unknown>) =>
  JSON.stringify({ version: 1, pid: 42, port: 3773, ...fields });

it("keeps a same-or-newer server and replaces an older or unidentified one", () => {
  assert.isTrue(keepsRunningServer(runtime({ serverVersion: "0.1.6" }), 42, "0.1.6"));
  assert.isTrue(
    keepsRunningServer(runtime({ serverVersion: "0.1.7-nightly.20261102.4080" }), 42, "0.1.6"),
  );
  assert.isFalse(
    keepsRunningServer(runtime({ serverVersion: "0.1.7-nightly.20261102.4080" }), 42, "0.1.7"),
  );
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "0.1.5" }), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "0.1.6" }), 7, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({}), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "latest" }), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer("", 42, "0.1.6"));
});
