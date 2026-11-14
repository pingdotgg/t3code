import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "@alchemy.run/test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/alchemy-test.ts");
const apiUrl = pathToFileURL(resolve(here, "../src/index.ts")).href;
const effectUrl = import.meta.resolve("effect/Effect");

it(
  "excludes exclusive-lock queue time from test durations",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-timing-"));
    try {
      await writeFile(
        resolve(root, "timing.test.ts"),
        `
        import { describe, it, expect } from ${JSON.stringify(apiUrl)};
        describe.concurrent("timing", () => {
          let finished = false;
          it("holder", async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            finished = true;
          });
          it("queued exclusive", () => {
            expect(finished).toBe(true);
          }, { exclusive: true });
        });
        `,
      );
      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      const duration = `${stdout}\n${stderr}`.match(/queued exclusive \((\d+)ms\)/);
      expect(duration).not.toBeNull();
      expect(Number(duration![1])).toBeLessThan(250);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "later tests overtake a waiting exclusive test, which then runs alone",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-exclusive-"));
    try {
      await writeFile(
        resolve(root, "exclusive.test.ts"),
        `
        import { describe, it, expect } from ${JSON.stringify(apiUrl)};
        describe.concurrent("exclusive", () => {
          let running = 0;
          let laterStarted = false;
          it("holder", async () => {
            running++;
            await new Promise(resolve => setTimeout(resolve, 300));
            running--;
          });
          it("waiting exclusive", () => {
            expect(laterStarted).toBe(true);
            expect(running).toBe(0);
          }, { exclusive: true });
          it("later", async () => {
            running++;
            laterStarted = true;
            await new Promise(resolve => setTimeout(resolve, 300));
            running--;
          });
        });
        `,
      );
      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(`${stdout}\n${stderr}`).toContain("3 passed");
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "exclusive labels serialize holders of the same label and nothing else",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-labels-"));
    try {
      await writeFile(
        resolve(root, "labels.test.ts"),
        `
        import { describe, it, expect } from ${JSON.stringify(apiUrl)};
        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        describe.concurrent("labels", () => {
          let activeA = 0;
          const holdA = async () => {
            activeA++;
            expect(activeA).toBe(1);
            await sleep(200);
            activeA--;
          };
          it("a1", holdA, { exclusive: "a" });
          it("a2", holdA, { exclusive: "a" });
          it("b", async () => {
            await sleep(50);
            expect(activeA).toBe(1);
          }, { exclusive: "b" });
          it("unlabeled", async () => {
            await sleep(50);
            expect(activeA).toBe(1);
          });
        });
        `,
      );
      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(`${stdout}\n${stderr}`).toContain("4 passed");
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "tag filters compose with names and skip excluded setup and teardown",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-tags-"));
    try {
      await writeFile(
        resolve(root, "tags.test.ts"),
        `
      import { describe, it, beforeAll, afterAll, expect } from ${JSON.stringify(apiUrl)};
      let ready = false;
      let ran = false;
      describe("selected", { tags: ["e2e", "provider:aws"] }, () => {
        beforeAll(() => { ready = true; });
        afterAll(() => { expect(ran).toBe(true); });
        describe("nested", { tags: ["live"] }, () => {
          it("chosen", () => { expect(ready).toBe(true); ran = true; });
          it("slow", () => { throw new Error("slow body ran"); }, { tags: "slow" });
          it("other-name", () => { throw new Error("name filter ignored"); });
        });
      });
      describe("excluded", { tags: ["e2e", "dev", "provider:cloudflare"] }, () => {
        beforeAll(() => { throw new Error("excluded setup ran"); });
        afterAll(() => { throw new Error("excluded teardown ran"); });
        it("chosen", () => { throw new Error("excluded body ran"); });
      });
      it("untagged", () => { throw new Error("untagged body ran"); });
    `,
      );
      const run = async (args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", ...args], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1" },
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, output: `${stdout}\n${stderr}` };
      };
      await writeFile(
        resolve(root, "excluded.test.ts"),
        `
      import { it, beforeAll, afterAll } from ${JSON.stringify(apiUrl)};
      beforeAll(() => { throw new Error("excluded file setup ran"); });
      afterAll(() => { throw new Error("excluded file teardown ran"); });
      it("excluded", () => { throw new Error("excluded file body ran"); }, { tags: "unit" });
    `,
      );
      const selected = await run([
        "--tags",
        "e2e && live && provider:*",
        "--tags",
        "!slow",
        "-t",
        "chosen",
      ]);
      expect(selected.exitCode).toBe(0);
      expect(selected.output).toContain("1 passed");
      expect(selected.output).toContain("selected > nested > chosen");
      const empty = await run(["--tags", "missing"]);
      expect(empty.exitCode).toBe(0);
      expect(empty.output).toContain("0 passed");

      await writeFile(
        resolve(root, "only.test.ts"),
        `
      import { it } from ${JSON.stringify(apiUrl)};
      it.only("only", () => { throw new Error("only bypassed tags"); }, { tags: "other" });
    `,
      );
      const only = await run(["--tags", "e2e"]);
      expect(only.exitCode).toBe(0);
      expect(only.output).toContain("0 passed");

      // Even an import that throws must not be reached with malformed syntax.
      await writeFile(resolve(root, "bad.test.ts"), 'throw new Error("IMPORTED_SENTINEL");');
      const invalid = await run(["--tags", "unit &&"]);
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.output).toContain("Invalid --tags");
      expect(invalid.output).not.toContain("IMPORTED_SENTINEL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

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

it(
  "streams file-hook output to the run log while the hook is still running",
  async () => {
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

      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", "--concurrency", "1"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
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
            const content = await readFile(resolve(logDir, entry), "utf8").catch(() => "");
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
  },
  { tags: ["unit", "local"] },
);

it(
  "--exclude skips folders unless they are passed explicitly",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-exclude-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(resolve(root, "test", "Railway"), { recursive: true });
      await mkdir(resolve(root, "test", "Other"), { recursive: true });
      const testFile = (name: string) => `
      import { it } from ${JSON.stringify(apiUrl)};
      it(${JSON.stringify(name)}, () => {});
    `;
      await Promise.all([
        writeFile(resolve(root, "test", "Railway", "Excluded.test.ts"), testFile("excluded-test")),
        writeFile(resolve(root, "test", "Other", "Included.test.ts"), testFile("included-test")),
      ]);

      const runCli = async (args: ReadonlyArray<string>) => {
        const child = Bun.spawn(
          [process.execPath, cli, ...args, "--retry", "0", "--concurrency", "1"],
          { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, output: `${stdout}\n${stderr}` };
      };

      // Default discovery with the exclusion: only the non-excluded file runs.
      const excluded = await runCli(["--exclude", "test/Railway"]);
      expect(excluded.exitCode).toBe(0);
      expect(excluded.output).toContain("included-test");
      expect(excluded.output).not.toContain("excluded-test");

      // An explicit positional root inside the excluded path overrides it.
      const explicit = await runCli(["test/Railway/Excluded.test.ts", "--exclude", "test/Railway"]);
      expect(explicit.exitCode).toBe(0);
      expect(explicit.output).toContain("excluded-test");

      // Non-path excludes degrade to case-insensitive substring filters.
      const substring = await runCli(["--exclude", "railway"]);
      expect(substring.exitCode).toBe(0);
      expect(substring.output).toContain("included-test");
      expect(substring.output).not.toContain("excluded-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "fails the process for every hook kind and preserves hook output",
  async () => {
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
        writeFile(resolve(root, "after-all.test.ts"), fixture("afterAll", 'it("body", () => {});')),
      ]);

      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", "--concurrency", "1"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
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
  },
  { tags: ["unit", "local"] },
);

it(
  "runs every afterAll hook even when an earlier one fails",
  async () => {
    // Regression: `runAfterAll` used to short-circuit on the first failing
    // hook, so a failing teardown assertion silently dropped every later
    // afterAll — in particular Test.make's fallback hook that closes the
    // shared scope and local provider sidecar, leaking the sidecar for the
    // rest of the process. All teardown hooks must run; failures aggregate.
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-afterall-"));
    try {
      await writeFile(
        resolve(root, "teardown-chain.test.ts"),
        `
        import { it, registerHook } from ${JSON.stringify(apiUrl)};
        import * as Effect from ${JSON.stringify(effectUrl)};
        registerHook("afterAll", { body: () => Effect.gen(function* () {
          return yield* Effect.fail(new Error("first-teardown-failed"));
        }) });
        registerHook("afterAll", { body: () => Effect.gen(function* () {
          yield* Effect.log("second-teardown-ran");
        }) });
        it("body", () => {});
      `,
      );

      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", "--concurrency", "1"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}\n${stderr}`;

      // The failure is reported and fails the run…
      expect(exitCode).toBe(1);
      expect(output).toContain("afterAll hook failed:");
      expect(output).toContain("first-teardown-failed");
      // …and the later teardown hook still ran.
      expect(output).toContain("second-teardown-ran");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "attributes imported tests and deferred hooks to their own files",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-collection-"));
    try {
      for (const name of ["first", "second"]) {
        const file = `${name}.test.ts`;
        await writeFile(
          resolve(root, file),
          `
          import { beforeAll, afterAll, currentFile, describe, expect, it } from ${JSON.stringify(apiUrl)};
          expect(currentFile()?.split("/").pop()).toBe(${JSON.stringify(file)});
          await new Promise(resolve => setTimeout(resolve, 10));
          expect(currentFile()?.split("/").pop()).toBe(${JSON.stringify(file)});
          let ready = false;
          let ran = false;
          queueMicrotask(() => {
            expect(currentFile()?.split("/").pop()).toBe(${JSON.stringify(file)});
            beforeAll(() => { ready = true; });
            afterAll(() => { expect(ran).toBe(true); });
          });
          describe("nested", () => {
            it(${JSON.stringify(name)}, () => {
              expect(currentFile()).toBeUndefined();
              expect(ready).toBe(true);
              ran = true;
            });
          });
        `,
        );
      }
      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", "--concurrency", "2"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(`${stdout}\n${stderr}`).toContain("first.test.ts > nested > first");
      expect(`${stdout}\n${stderr}`).toContain("second.test.ts > nested > second");
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "opt-in tags gate execution and hooks until explicitly selected",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-opt-in-"));
    const file = resolve(root, "opt-in.test.ts");
    try {
      await writeFile(
        file,
        `
      import { describe, it, beforeAll, afterAll, expect } from ${JSON.stringify(apiUrl)};
      let ran = false;
      describe("gated", { tags: ["e2e", "provider:aws"], optInTags: ["slow"] }, () => {
        beforeAll(() => { if (!process.env.EXPECT_ENABLED) throw new Error("excluded setup ran"); });
        afterAll(() => { expect(ran).toBe(true); });
        it("single", () => { ran = true; });
        it("double", () => { ran = true; }, { optInTags: ["enterprise"] });
      });
      it("ordinary", () => {}, { tags: ["unit", "slow"] });
    `,
      );
      const run = async (args: string[], enabled = false) => {
        const child = Bun.spawn([process.execPath, cli, file, "--retry", "0", ...args], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1", EXPECT_ENABLED: enabled ? "1" : "" },
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        return `${stdout}\n${stderr}`;
      };
      expect(await run([])).toContain("1 passed");
      expect(await run(["--tags", "*"])).toContain("1 passed");
      for (const filter of ["provider:aws", "!unit", "sl*", "!!slow"]) {
        expect(await run(["--tags", filter, "-t", "gated"])).toContain("0 passed");
      }
      expect(await run(["-t", "gated"])).toContain("0 passed");
      expect(await run(["--tags", "slow && provider:aws"], true)).toContain("1 passed");
      expect(await run(["--tags", "slow", "--tags", "enterprise"], true)).toContain("1 passed");
      await writeFile(
        file,
        `
      import { it } from ${JSON.stringify(apiUrl)};
      it.only("gated", () => { throw new Error("only bypassed opt-in"); }, { optInTags: ["slow"] });
    `,
      );
      expect(await run([])).toContain("0 passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"], timeout: 90_000 },
);

it(
  "fails and abandons test bodies, retries and hooks that outlive their timeout",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-deadline-"));
    const header = `
      import { describe, it, registerHook } from ${JSON.stringify(apiUrl)};
      import * as Effect from ${JSON.stringify(effectUrl)};
      const hang = () => Effect.uninterruptible(Effect.never);
    `;
    const hookFixture = (kind: string, timeout = ", timeout: 300") => `${header}
      describe(${JSON.stringify(kind)}, () => {
        registerHook(${JSON.stringify(kind)}, { body: hang${timeout} });
        it("body", () => {});
      });
    `;
    try {
      await Promise.all([
        writeFile(
          resolve(root, "body.test.ts"),
          `${header}
          it.effect("uninterruptible body", hang, { timeout: 300 });
          it("never-resolving promise body", () => new Promise(() => {}), { timeout: 300 });
          it.effect("hung finalizer body", () =>
            Effect.addFinalizer(() => Effect.never).pipe(Effect.andThen(Effect.never)),
            { timeout: 300 });
          it.effect("retried uninterruptible body", hang, { timeout: 300, retry: 2 });
          `,
        ),
        writeFile(resolve(root, "before-all.test.ts"), hookFixture("beforeAll")),
        writeFile(resolve(root, "before-each.test.ts"), hookFixture("beforeEach")),
        writeFile(resolve(root, "after-each.test.ts"), hookFixture("afterEach")),
        // No hook timeout: falls back to the run's --timeout.
        writeFile(resolve(root, "after-all.test.ts"), hookFixture("afterAll", "")),
      ]);

      const started = Date.now();
      const child = Bun.spawn([process.execPath, cli, root, "--retry", "0", "--timeout", "300"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", ALCHEMY_TEST_TEARDOWN_GRACE_MS: "500" },
        // A regression hangs forever; kill it so the assertion fails instead.
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const elapsed = Date.now() - started;
      const output = `${stdout}\n${stderr}`;

      expect(exitCode).toBe(1);
      const abandoned = "(teardown did not settle within 500ms and was abandoned)";
      expect(output).toContain(`test timed out after 300ms ${abandoned}`);
      expect(output).toContain("test timed out after 300ms\n");
      expect(output).toContain(`hook timed out after 300ms ${abandoned}`);
      for (const hook of ["beforeAll", "beforeEach", "afterEach", "afterAll"]) {
        expect(output).toContain(`${hook} hook failed:`);
      }
      expect(output).toMatch(/retried uninterruptible body \([\d.]+m?s\) \[retried x2\]/);
      expect(output).toContain("Tests: 8 failed | 1 passed");
      // Every hang is bounded by (timeout + grace) per attempt.
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"], timeout: 90_000 },
);
