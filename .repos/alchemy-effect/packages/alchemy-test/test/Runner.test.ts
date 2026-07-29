import { expect, it } from "alchemy-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/alchemy-test.ts");
const apiUrl = pathToFileURL(resolve(here, "../src/index.ts")).href;
const effectUrl = pathToFileURL(
  resolve(here, "../../../node_modules/effect/dist/Effect.js"),
).href;

const fixture = (hook: string, body: string): string => `
  import { it, registerHook } from ${JSON.stringify(apiUrl)};
  import * as Effect from ${JSON.stringify(effectUrl)};
  registerHook(${JSON.stringify(hook)}, { body: () => Effect.gen(function* () {
    yield* Effect.log(${JSON.stringify(`${hook}-captured-output`)});
    return yield* Effect.fail(new Error(${JSON.stringify(`${hook}-sentinel`)}));
  })
  });
  ${body}
`;

it("streams file-hook output to the run log while the hook is still running", async () => {
  // Regression: file-level hook output (deploy/destroy) used to be buffered
  // until FileEnd, so a long-running beforeAll produced a run log that
  // stopped growing entirely — a multi-minute cloud deploy read as a
  // deadlocked run (0% CPU, silent log). Hook log entries must reach the
  // per-run log file WHILE the hook is still executing.
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-livehook-"));
  try {
    await writeFile(
      resolve(root, "live-hook.test.ts"),
      `
        import { it, registerHook } from ${JSON.stringify(apiUrl)};
        import * as Effect from ${JSON.stringify(effectUrl)};
        registerHook("beforeAll", { body: () => Effect.gen(function* () {
          yield* Effect.log("hook-live-sentinel");
          yield* Effect.sleep("8 seconds");
        }) });
        it("body", () => {});
      `,
    );

    const child = Bun.spawn(
      [process.execPath, cli, root, "--retry", "0", "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    try {
      // Poll the run log (created under the child's cwd) for the sentinel.
      // The hook sleeps 8s after logging; seeing the sentinel within ~6s
      // proves it was streamed mid-hook, not flushed at FileEnd.
      const logDir = resolve(root, ".alchemy", "log", "test");
      const deadline = Date.now() + 6_000;
      let streamed = false;
      while (Date.now() < deadline) {
        const { readdir, readFile } = await import("node:fs/promises");
        const entries = await readdir(logDir).catch(() => [] as string[]);
        for (const entry of entries) {
          const content = await readFile(resolve(logDir, entry), "utf8").catch(
            () => "",
          );
          if (content.includes("hook-live-sentinel")) {
            streamed = true;
            break;
          }
        }
        if (streamed) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(streamed).toBe(true);

      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails the process for every hook kind and preserves hook output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-hooks-"));
  try {
    await Promise.all([
      writeFile(
        resolve(root, "before-all.test.ts"),
        fixture("beforeAll", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "before-each.test.ts"),
        fixture("beforeEach", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "after-each.test.ts"),
        fixture(
          "afterEach",
          'it.fails("expected body failure", () => { throw new Error("expected-body-failure"); });',
        ),
      ),
      writeFile(
        resolve(root, "after-all.test.ts"),
        fixture("afterAll", 'it("body", () => {});'),
      ),
    ]);

    const child = Bun.spawn(
      [process.execPath, cli, root, "--retry", "0", "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("beforeAll hook failed:");
    expect(output).toContain("beforeEach hook failed:");
    expect(output).toContain("afterEach hook failed:");
    expect(output).toContain("afterAll hook failed:");
    expect(output).toContain("Tests: 4 failed | 1 passed");
    for (const hook of ["beforeAll", "beforeEach", "afterEach", "afterAll"]) {
      expect(output).toContain(`${hook}-captured-output`);
      expect(output).toContain(`${hook}-sentinel`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
