import { assert, describe } from "vite-plus/test";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/namespace-node-imports");

describe("t3code/namespace-node-imports", () => {
  rule.valid(
    "allows canonical Node namespaces",
    `
      import * as NodeFS from "node:fs";
      import * as NodeFSP from "node:fs/promises";
      import * as NodeAssert from "node:assert/strict";
      import * as NodeChildProcess from "node:child_process";
      import * as NodeTimersPromises from "node:timers/promises";
      import type * as NodeStream from "node:stream";

      NodeAssert.ok(NodeChildProcess.spawn && NodeTimersPromises.setTimeout);
      export const read = NodeFS.readFileSync;
      export const readAsync = NodeFSP.readFile;
      export type Input = NodeStream.Readable;
    `,
  );

  rule.valid(
    "does not apply to non-Node packages",
    `
      import { BrowserWindow } from "electron";
    `,
  );

  rule.invalid(
    "reports named imports",
    `
      import { readFile } from "node:fs/promises";
    `,
    (output) => {
      assert.match(output, /namespace named NodeFSP/);
    },
  );

  rule.invalid(
    "reports default imports",
    `
      import path from "node:path";
    `,
    (output) => {
      assert.match(output, /namespace named NodePath/);
    },
  );

  rule.invalid(
    "reports non-canonical namespace aliases",
    `
      import * as Crypto from "node:crypto";
      import * as NodeOs from "node:os";
    `,
    (output) => {
      assert.match(output, /namespace named NodeCrypto/);
      assert.match(output, /namespace named NodeOS/);
    },
  );
});
