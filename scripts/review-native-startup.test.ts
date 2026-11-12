import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";

// Vitest's DOM setup can hide this native startup crash; load the actual modules
// in a fresh process with no browser globals or web-component registration.
describe("native diff startup", () => {
  it("loads shared staging arithmetic and parses full file data without a DOM", async () => {
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
    const result = await Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const child = yield* spawner.spawn(
        ChildProcess.make(
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
          { cwd: yield* path.fromFileUrl(new URL("..", import.meta.url)) },
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(exitCode), stderr).toBe(0);
      return stdout;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
    expect(result.trim()).toBe("native startup passed");
  });
});
