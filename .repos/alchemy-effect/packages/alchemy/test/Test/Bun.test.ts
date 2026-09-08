import { describe, expect, test } from "alchemy-test";
import { fileURLToPath } from "node:url";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("Bun adapter fallback cleanup", () => {
  test(
    "closes the shared scope when a user afterAll throws",
    async () => {
      // bun:test stops the afterAll chain on the first throw, so without
      // the adapter's teardown guard the microtask-registered fallback
      // (which closes the shared scope + sidecar) never runs. The fixture's
      // shared-scope finalizer printing proves the guard closed the scope;
      // the non-zero exit proves the teardown failure still fails the run.
      const child = Bun.spawn(
        ["bun", "test", "./bun-teardown-guard.fixture.ts"],
        {
          cwd: fixturesDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1", ALCHEMY_DEV: "" },
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}\n${stderr}`;

      expect(exitCode).not.toBe(0);
      expect(output).toContain("teardown-assertion-failed");
      const userHook = output.indexOf("BUN_GUARD:user-afterAll-throws");
      const finalizer = output.indexOf("BUN_GUARD:shared-scope-finalizer-ran");
      expect(userHook).toBeGreaterThanOrEqual(0);
      // The cleanup ran, and ran after the failing user teardown.
      expect(finalizer).toBeGreaterThan(userHook);
    },
    { timeout: 60_000 },
  );
});
