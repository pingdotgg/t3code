// @effect-diagnostics nodeBuiltinImport:off - Exercises real native startup imports in a process without DOM globals.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

// Vitest's DOM setup can hide this native startup crash; load the actual modules
// in a fresh process with no browser globals or web-component registration.
describe("native diff startup", () => {
  it("loads shared staging arithmetic and parses full file data without a DOM", () => {
    const entry = new URL("../packages/client-runtime/src/reviewDiffMetadata.ts", import.meta.url)
      .href;
    const staging = new URL(
      "../packages/client-runtime/src/reviewWorkingChangesState.ts",
      import.meta.url,
    ).href;
    const native = new URL(
      "../apps/mobile/src/features/review/workingChangesProjection.ts",
      import.meta.url,
    ).href;
    const result = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from 'node:assert/strict';
          for (const name of ['window', 'document', 'HTMLElement', 'customElements']) {
            assert.equal(name in globalThis, false);
          }
          const { parseReviewDiffFromFiles } = await import(${JSON.stringify(entry)});
          await import(${JSON.stringify(staging)});
          await import(${JSON.stringify(native)});
          const file = parseReviewDiffFromFiles(
            { name: 'file.txt', contents: 'old\\n' },
            { name: 'file.txt', contents: 'new\\n' },
          );
          assert.equal(file.isPartial, false);
          assert.equal(file.hunks.length, 1);
          assert.equal(file.additionLines[0], 'new\\n');
          console.log('native startup passed');
        `,
      ],
      { cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
    );
    expect(result.trim()).toBe("native startup passed");
  });
});
