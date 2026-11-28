// @effect-diagnostics nodeBuiltinImport:off -- Exercise the environment received by a real child.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { expect, it } from "@effect/vitest";

import { discardLegacyGmailEnvironment } from "./gmailServerEnv.ts";

it("keeps retired Gmail credentials out of spawned provider processes", async () => {
  const serverEnv = {
    HYAKKI_GMAIL_CLIENT_ID: "old-client",
    HYAKKI_GMAIL_CLIENT_SECRET: "fixture-secret",
    HYAKKI_GMAIL_DESKTOP_CLIENT_ID: "old-desktop-client",
    CHILD_MARKER: "unchanged",
  };
  discardLegacyGmailEnvironment(serverEnv);
  expect(serverEnv).toEqual({ CHILD_MARKER: "unchanged" });
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    [
      "-e",
      "console.log(Object.hasOwn(process.env, 'HYAKKI_GMAIL_CLIENT_SECRET'), process.env.CHILD_MARKER)",
    ],
    { env: serverEnv },
  );
  expect(stdout.trim()).toBe("false unchanged");
});
