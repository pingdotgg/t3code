import { expect, it } from "alchemy-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/alchemy-test.ts");
const api = JSON.stringify(
  pathToFileURL(resolve(here, "../src/index.ts")).href,
);

const run = async (root: string, plan: unknown, args: string[] = []) => {
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      root,
      "--retry",
      "0",
      "--timeout",
      "2000",
      "--concurrency",
      "1",
      "--plan",
      typeof plan === "string" ? plan : JSON.stringify(plan),
      ...args,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
};

it(
  "plans sequence phases, overlap branches, honor file concurrency, and claim tests once",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-"));
    try {
      await writeFile(
        resolve(root, "state.ts"),
        `
      export const local = new Set();
      export const cleaned = new Set();
      export const live = new Set();
      export const calls = new Set();
      const releases = {};
      const arrivals = {};
      export async function barrier(name) {
        const promise = new Promise(resolve => (releases[name] ??= []).push(resolve));
        arrivals[name] = (arrivals[name] ?? 0) + 1;
        if (arrivals[name] === 2) for (const release of releases[name]) release();
        await promise;
      }
    `,
      );
      for (const name of ["a", "b"])
        await writeFile(
          resolve(root, `local-${name}.test.ts`),
          `
      import { it, expect, afterAll } from ${api};
      import {local, cleaned, barrier} from './state.ts';
      it('local ${name}', async () => { await barrier('local'); local.add('${name}'); }, {tags:['local']});
      afterAll(() => { cleaned.add('${name}'); });
    `,
        );
      for (const provider of ["aws", "cloudflare"])
        await writeFile(
          resolve(root, `${provider}.test.ts`),
          `
      import { it, expect } from ${api};
      import {local, cleaned, live, calls, barrier} from './state.ts';
      it('${provider}', async () => {
        expect(local.size).toBe(2); expect(cleaned.size).toBe(2);
        expect(calls.has('${provider}')).toBe(false); calls.add('${provider}');
        await barrier('providers'); live.add('${provider}');
      }, {tags:['live','provider:${provider}']});
    `,
        );
      await writeFile(
        resolve(root, "shared.test.ts"),
        `
      import { it, expect, beforeAll, afterAll } from ${api};
      import {local, live} from './state.ts';
      let setups = 0, early = false, late = false;
      beforeAll(() => { setups++; expect(setups).toBe(1); });
      afterAll(() => { expect(early).toBe(true); expect(late).toBe(true); });
      it('early', () => { early = true; }, {tags:['local']});
      it('remaining live', () => { expect(early).toBe(true); expect(live.size).toBe(2); late = true; }, {tags:['live']});
      it.skip('selected skipped', () => { throw new Error('skip ignored'); }, {tags:['live']});
      it('unmatched', () => { throw new Error('unmatched ran'); }, {tags:['manual']});
      it('opt in', () => { throw new Error('opt-in bypassed'); }, {tags:['live'], optInTags:['paid']});
    `,
      );
      const result = await run(root, [
        { tags: ["local"], concurrency: 3 },
        [
          { tags: ["provider:aws", "live"], concurrency: 1 },
          { tags: ["provider:cloudflare", "live"], concurrency: 1 },
        ],
        { tags: ["live"] },
      ]);
      expect(result.output).toContain("6 passed");
      expect(result.output).toContain("1 skipped");
      expect(result.output).toContain("9 found");
      expect(result.output).toContain("7 selected by plan");
      expect(result.output).toContain("2 excluded by plan");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "plan branches sharing a file serialize setup and preserve it until final teardown",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-shared-"));
    try {
      await writeFile(
        resolve(root, "shared.test.ts"),
        `
      import { it, expect, beforeAll, afterAll } from ${api};
      let ready = false, setup = 0, done = 0, active = false;
      beforeAll(() => { expect(++setup).toBe(1); ready = true; });
      afterAll(() => { expect(done).toBe(2); ready = false; });
      for (const tag of ['aws','cf']) it(tag, async () => {
        expect(ready).toBe(true); expect(active).toBe(false); active = true;
        await new Promise(resolve => setTimeout(resolve, 20));
        active = false; done++;
      }, {tags:[tag]});
    `,
      );
      const result = await run(root, [
        [{ tags: ["aws"] }, { tags: ["cf"] }],
        { tags: [] },
      ]);
      expect(result.output).toContain("2 passed");
      expect(result.output).toContain("0 excluded by plan");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "plans do not rerun failures and still run later phases and all teardown hooks",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-fail-"));
    try {
      await writeFile(
        resolve(root, "failure.test.ts"),
        `
      import { it, expect, afterAll } from ${api};
      let attempts = 0, later = false;
      it('failure', () => { attempts++; throw new Error('expected failure'); }, {tags:['early','live']});
      it('later', () => { expect(attempts).toBe(1); later = true; }, {tags:['live']});
      afterAll(() => { expect(later).toBe(true); throw new Error('teardown sentinel'); });
      afterAll(() => console.log('cleanup sentinel'));
    `,
      );
      const result = await run(root, [{ tags: ["early"] }, { tags: ["live"] }]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("2 failed");
      expect(result.output).toContain("1 passed");
      expect(result.output).toContain("teardown sentinel");
      // The runner writes hook output to its persistent log even on failure.
      const { readdir, readFile } = await import("node:fs/promises");
      const dir = resolve(root, ".alchemy/log/test");
      const logs = await readdir(dir);
      expect(await readFile(resolve(dir, logs[0]!), "utf8")).toContain(
        "cleanup sentinel",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "validates plan JSON and tag expressions before importing tests",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-invalid-"));
    try {
      await writeFile(
        resolve(root, "bad.test.ts"),
        `throw new Error('IMPORTED_SENTINEL');`,
      );
      for (const plan of [
        "{",
        [],
        [{}],
        [{ tags: ["unit"], concurrency: 0 }],
        [{ tags: ["unit"], concurrency: 1.5 }],
        [{ tags: ["unit"], concurency: 2 }],
        [[]],
        [[[{ tags: [] }]]],
        [{ tags: ["unit &&"] }],
      ]) {
        const result = await run(root, plan);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("Invalid --plan");
        expect(result.output).not.toContain("IMPORTED_SENTINEL");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "plans compose with global tags, names and explicit opt-ins",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-filters-"));
    try {
      await writeFile(
        resolve(root, "filters.test.ts"),
        `
      import { it } from ${api};
      it('chosen', () => {}, {tags:['live','provider:aws'], optInTags:['paid']});
      it('other name', () => { throw new Error('name bypassed'); }, {tags:['live','provider:aws'], optInTags:['paid']});
      it('chosen cf', () => { throw new Error('global tags bypassed'); }, {tags:['live','provider:cloudflare'], optInTags:['paid']});
    `,
      );
      const result = await run(
        root,
        [{ tags: ["paid", "live"] }],
        ["--tags", "provider:aws", "-t", "^.* > chosen$"],
      );
      expect(result.output).toContain("1 passed");
      expect(result.output).toContain("1 found");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "failed shared setup is not retried by later phases and still tears down once",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-setup-"));
    try {
      await writeFile(
        resolve(root, "setup.test.ts"),
        `
      import { it, beforeAll, afterAll, expect } from ${api};
      let setups = 0;
      beforeAll(() => { setups++; throw new Error('setup sentinel'); });
      afterAll(() => { expect(setups).toBe(1); });
      it('first', () => { throw new Error('body ran'); }, {tags:['first']});
      it('last', () => { throw new Error('body ran'); }, {tags:['last']});
    `,
      );
      const result = await run(root, [{ tags: ["first"] }, { tags: ["last"] }]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("2 failed");
      expect(result.output).toContain("setup sentinel");
      expect(result.output).not.toContain("body ran");
      expect(result.output).not.toContain("afterAll hook failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "plans honor only and wildcard phases leave opt-in tests for an explicit later phase",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-only-"));
    try {
      await writeFile(
        resolve(root, "only.test.ts"),
        `
      import { describe, it, expect, beforeAll } from ${api};
      let ready = false;
      describe.only('selected suite', () => {
        it('normal', () => { ready = true; }, {tags:['live']});
        it('opt-in', () => { expect(ready).toBe(true); }, {tags:['live'], optInTags:['paid']});
      });
      describe('excluded suite', () => {
        beforeAll(() => { throw new Error('excluded setup'); });
        it('excluded', () => { throw new Error('only bypassed'); });
      });
    `,
      );
      const result = await run(root, [{ tags: ["*"] }, { tags: ["paid"] }]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("2 passed");
      expect(result.output).toContain("Plan phase 1/2: 1 tests");
      expect(result.output).toContain("Plan phase 2/2: 1 tests");
      expect(result.output).toContain("2 found");
      expect(result.output).toContain("0 excluded by plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "unmatched plans do not run hooks but still report import errors",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-empty-"));
    try {
      await writeFile(
        resolve(root, "good.test.ts"),
        `
      import { it, beforeAll, afterAll } from ${api};
      beforeAll(() => { throw new Error('unmatched setup'); });
      afterAll(() => { throw new Error('unmatched teardown'); });
      it('unmatched', () => { throw new Error('unmatched body'); }, {tags:['live']});
    `,
      );
      await writeFile(
        resolve(root, "bad.test.ts"),
        `throw new Error('import sentinel');`,
      );
      const result = await run(root, [{ tags: ["local"] }, { tags: ["unit"] }]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("1 failed");
      expect(result.output).toContain("import sentinel");
      expect(result.output).toContain("1 excluded by plan");
      expect(result.output).not.toContain("unmatched setup");
      expect(result.output).not.toContain("unmatched teardown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "dry-run prints first-match assignments and concurrency without executing bodies or hooks",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-dry-"));
    try {
      await writeFile(
        resolve(root, "dry.test.ts"),
        `
      import { it, beforeAll, afterAll } from ${api};
      beforeAll(() => { throw new Error('DRY_SETUP_RAN'); });
      afterAll(() => { throw new Error('DRY_TEARDOWN_RAN'); });
      it('local aws', () => { throw new Error('DRY_BODY_RAN'); }, {tags:['local','live','provider:aws']});
      it('aws', () => { throw new Error('DRY_BODY_RAN'); }, {tags:['live','provider:aws']});
      it.skip('cf', () => {}, {tags:['live','provider:cloudflare']});
      it('left over', () => { throw new Error('DRY_BODY_RAN'); }, {tags:['manual']});
    `,
      );
      const result = await run(
        root,
        [
          { tags: ["local"], concurrency: 64 },
          [
            { tags: ["live", "provider:aws"], concurrency: 2 },
            { tags: ["live", "provider:cloudflare"], concurrency: "unbounded" },
          ],
          { tags: ["live"] },
        ],
        ["--dry-run"],
      );
      expect(result.code).toBe(0);
      expect(result.output).toContain("Dry run — no tests or hooks executed");
      expect(result.output).toContain("Phase 2 (parallel)");
      expect(result.output).toContain(
        'tags=["local"], concurrency=64 — 1 tests in 1 files',
      );
      expect(result.output).toContain(
        'tags=["live","provider:aws"], concurrency=2 — 1 tests in 1 files',
      );
      expect(result.output).toContain(
        "concurrency=unbounded — 1 tests in 1 files (1 skipped/todo)",
      );
      expect(result.output).toContain(
        'tags=["live"], concurrency=1 — 0 tests in 0 files',
      );
      expect(result.output).toContain("4 found");
      expect(result.output).toContain("3 selected by plan");
      expect(result.output).toContain("1 excluded by plan");
      expect(result.output).not.toContain("DRY_SETUP_RAN");
      expect(result.output).not.toContain("DRY_TEARDOWN_RAN");
      expect(result.output).not.toContain("DRY_BODY_RAN");
      expect(result.output).not.toContain("running 3 tests");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);

it(
  "dry-run reports collection failures",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "alchemy-plan-dry-error-"));
    try {
      await writeFile(
        resolve(root, "bad.test.ts"),
        `throw new Error('dry import sentinel');`,
      );
      const result = await run(root, [{ tags: [] }], ["--dry-run"]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("dry import sentinel");
      expect(result.output).toContain("1 failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "local"] },
);
