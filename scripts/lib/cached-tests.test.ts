// @effect-diagnostics nodeBuiltinImport:off - verifies native task caching in isolated subprocesses.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { cachedTestTasks, matchesTestPath } from "./cached-tests.ts";

describe("cachedTestTasks", () => {
  it("selects every test for a checkout-root path", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    for (const path of [".", root]) {
      expect(
        matchesTestPath("apps/server/src/auth/utils.test.ts", [
          NodePath.relative(root, NodePath.resolve(root, path)),
        ]),
      ).toBe(true);
    }
    expect(matchesTestPath("apps/server/src/auth/utils.test.ts", ["apps/server"])).toBe(true);
    expect(matchesTestPath("apps/server-other/a.test.ts", ["apps/server"])).toBe(false);
  });
  it("keeps a file's cache task stable when unrelated tests are added", () => {
    const first = cachedTestTasks(JSON.stringify({ files: ["src/b.test.ts"], groupSize: 1 }));
    const second = cachedTestTasks(
      JSON.stringify({ files: ["src/a.test.ts", "src/b.test.ts"], groupSize: 1 }),
    );
    const key = Object.keys(first).find((key) => key !== "test-cache")!;
    expect(second[key]).toEqual(first[key]);
  });

  it("preserves package grouping, task order, and duplicates with uncached files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-groups-"));
    const files = ["pkg/z.test.ts", "b.test.ts", "a.test.ts", "pkg/y.test.ts", "a.test.ts"];
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "pkg"));
      await NodeFSP.writeFile(NodePath.join(directory, "package.json"), "{}");
      await NodeFSP.writeFile(
        NodePath.join(directory, "pkg/package.json"),
        JSON.stringify({ scripts: { test: "vp test run --passWithNoTests" } }),
      );
      for (const { uncached, groups } of [
        {
          uncached: undefined,
          groups: [
            ["a.test.ts", "b.test.ts"],
            ["pkg/y.test.ts", "pkg/z.test.ts"],
          ],
        },
        {
          uncached: [],
          groups: [
            ["a.test.ts", "b.test.ts"],
            ["pkg/y.test.ts", "pkg/z.test.ts"],
          ],
        },
        {
          uncached: ["missing.test.ts"],
          groups: [
            ["a.test.ts", "b.test.ts"],
            ["pkg/y.test.ts", "pkg/z.test.ts"],
          ],
        },
        {
          uncached: ["a.test.ts", "a.test.ts", "pkg/z.test.ts", "missing.test.ts"],
          groups: [["b.test.ts"], ["a.test.ts"], ["pkg/y.test.ts"], ["pkg/z.test.ts"]],
        },
        {
          uncached: files,
          groups: [["a.test.ts"], ["b.test.ts"], ["pkg/y.test.ts"], ["pkg/z.test.ts"]],
        },
      ]) {
        const expected: ReturnType<typeof cachedTestTasks> = {};
        for (const group of groups) {
          const inPackage = group[0]!.startsWith("pkg/");
          const key = `test-cache:${NodeCrypto.createHash("sha256").update(group.join("\0")).digest("hex")}`;
          expected[key] = {
            command: `${inPackage ? "vp test run --passWithNoTests" : "vp test run"} ${group.map((file) => `'${inPackage ? file.slice(4) : file}'`).join(" ")}`,
            ...(inPackage ? { cwd: "pkg" } : {}),
            cache: uncached?.includes(group[0]!)
              ? false
              : {
                  input: [
                    { auto: true },
                    "!**/node_modules/.vite/**",
                    "!**/node_modules/.vitest-cache/**",
                  ],
                  output: [],
                },
          };
        }
        expected["test-cache"] = {
          command: 'node -e ""',
          dependsOn: Object.keys(expected),
          cache: false,
        };
        const tasks = cachedTestTasks(JSON.stringify({ files, groupSize: 2, uncached }), directory);
        expect(tasks).toEqual(expected);
        expect(Object.keys(tasks)).toEqual(Object.keys(expected));
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps shell metacharacters in filenames out of the command", () => {
    for (const uncached of [[], ["src/a'$(touch injected).test.ts"]]) {
      const tasks = cachedTestTasks(
        JSON.stringify({ files: ["src/a'$(touch injected).test.ts"], groupSize: 1, uncached }),
      );
      const task = Object.entries(tasks).find(([key]) => key !== "test-cache")![1];
      expect(task.command).toBe("vp test run 'src/a'\"'\"'$(touch injected).test.ts'");
    }
  });

  it("rejects paths outside the checkout and empty groups", () => {
    for (const request of [
      { files: ["../elsewhere.test.ts"], groupSize: 1 },
      { files: ["/absolute.test.ts"], groupSize: 1 },
      { files: ["src/a.test.ts"], groupSize: 0 },
      ...[null, "src/a.test.ts", {}, [null], [1], ["src/a.test.ts", false]].map((uncached) => ({
        files: ["src/a.test.ts"],
        groupSize: 1,
        uncached,
      })),
    ]) {
      expect(() => cachedTestTasks(JSON.stringify(request))).toThrow();
    }
  });

  it("accepts spec files discovered by Vitest", () => {
    const tasks = cachedTestTasks(JSON.stringify({ files: ["src/example.spec.ts"], groupSize: 1 }));
    expect(
      Object.values(tasks).some((task) => task.command === "vp test run 'src/example.spec.ts'"),
    ).toBe(true);
  });

  it("does not add tasks without an explicit request", () => {
    expect(cachedTestTasks(undefined)).toEqual({});
    expect(
      cachedTestTasks(JSON.stringify({ files: [], groupSize: 2, uncached: ["missing.test.ts"] })),
    ).toEqual({
      "test-cache": { command: 'node -e ""', dependsOn: [], cache: false },
    });
  });

  it("reuses individual results, invalidates filesystem inputs, and never caches failures", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-tests-"));
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const run = (files = ["a.test.ts", "b.test.ts"], uncached: Array<string> = [], groupSize = 1) =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(root, "node_modules/vite-plus/dist/bin.js"), "run", "test-cache"],
          {
            cwd: directory,
            env: {
              ...process.env,
              NODE_OPTIONS: "",
              VP_REMOTE_CACHE: "off",
              T3_CACHED_TESTS: JSON.stringify({ files, groupSize, uncached }),
              VITE_CACHE_PATH: NodePath.join(directory, "cache"),
              PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
            },
            stdio: "ignore",
          },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    const summary = async () => {
      const value: { tasks: Array<{ result: Record<string, unknown> }> } = JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "cache/v18/last-summary.json"), "utf8"),
      );
      return value.tasks.filter((task) => "CacheHit" in task.result).length;
    };
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "node_modules"));
      await NodeFSP.symlink(
        NodePath.join(root, "node_modules/vite-plus"),
        NodePath.join(directory, "node_modules/vite-plus"),
        "dir",
      );
      await NodeFSP.writeFile(NodePath.join(directory, "package.json"), '{"type":"module"}');
      await NodeFSP.writeFile(
        NodePath.join(directory, "vite.config.ts"),
        `import {cachedTestTasks} from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/cached-tests.ts")).href)}; export default {run:{tasks:cachedTestTasks(process.env.T3_CACHED_TESTS, import.meta.dirname)},test:{include:["*.test.ts"]}};`,
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "a.test.ts"),
        'import {test,expect} from "vite-plus/test"; import {readFileSync} from "node:fs"; test("fixture",()=>expect(readFileSync("fixture.txt","utf8")).toMatch(/^hello/));',
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "b.test.ts"),
        'import {test,expect} from "vite-plus/test"; test("independent",()=>expect(1).toBe(1));',
      );
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello");
      expect(await run()).toBe(0);
      expect(await run()).toBe(0);
      expect(await summary()).toBe(2);
      expect(await run(["b.test.ts"])).toBe(0);
      expect(await summary()).toBe(1);
      expect(await run()).toBe(0);
      expect(await summary()).toBe(2);
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello changed");
      expect(await run()).toBe(0);
      expect(await summary()).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "broken");
      expect(await run()).toBe(1);
      expect(await run()).toBe(1);
      expect(await summary()).toBe(1);
      await NodeFSP.writeFile(NodePath.join(directory, "fixture.txt"), "hello again");
      await NodeFSP.writeFile(
        NodePath.join(directory, "b.test.ts"),
        'import {test} from "vite-plus/test";import {writeFileSync} from "node:fs";test("report",()=>writeFileSync("report.json","{}"));',
      );
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      await NodeFSP.unlink(NodePath.join(directory, "report.json"));
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(directory, "report.json"), "utf8")).toBe("{}");
      await NodeFSP.writeFile(
        NodePath.join(directory, "b.test.ts"),
        'import {test,expect} from "vite-plus/test";test("independent",()=>expect(1).toBe(1));',
      );
      await NodeFSP.mkdir(NodePath.join(directory, "reports"));
      for (const name of ["c", "d"]) {
        await NodeFSP.writeFile(
          NodePath.join(directory, `${name}.test.ts`),
          `import {test} from "vite-plus/test";import {writeFileSync} from "node:fs";test("report",()=>writeFileSync("reports/${name}.json","${name}"));`,
        );
      }
      const files = ["d.test.ts", "b.test.ts", "c.test.ts", "a.test.ts", "c.test.ts"];
      const uncached = ["c.test.ts", "d.test.ts", "c.test.ts", "missing.test.ts"];
      expect(await run(files, uncached, 2)).toBe(0);
      for (const name of ["c", "d"]) {
        await NodeFSP.unlink(NodePath.join(directory, "reports", `${name}.json`));
      }
      expect(await run(files, uncached, 2)).toBe(0);
      expect(await summary()).toBe(1);
      for (const name of ["c", "d"]) {
        expect(
          await NodeFSP.readFile(NodePath.join(directory, "reports", `${name}.json`), "utf8"),
        ).toBe(name);
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
