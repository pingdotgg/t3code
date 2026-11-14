import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const adapter = resolve(import.meta.dirname, "../src/Bun.ts");
const effect = import.meta.resolve("effect/Effect");

// A `beforeAll` that outlives bun's hook timeout is interrupted before bun
// gives up on it, so its finalizers run before `afterAll`, the way a deploy
// must record what it created before the file's destroy runs.
test("a hook that outlives its timeout is interrupted before afterAll runs", () => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-test-bun-deadline-"));
  try {
    writeFileSync(
      join(root, "deadline.test.ts"),
      `
      import * as Test from ${JSON.stringify(adapter)};
      import * as Effect from ${JSON.stringify(effect)};
      const { beforeAll, afterAll } = Test.make({ providers: [] as any });
      let interrupted = false;
      beforeAll(
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; }))),
        { timeout: 12_000 },
      );
      afterAll(Effect.sync(() => console.log("INTERRUPTED_BEFORE_AFTERALL=" + interrupted)));
    `,
    );
    const result = spawnSync(process.execPath, ["test", "deadline.test.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 40_000,
    });
    expect(result.stdout + result.stderr).toContain("INTERRUPTED_BEFORE_AFTERALL=true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
