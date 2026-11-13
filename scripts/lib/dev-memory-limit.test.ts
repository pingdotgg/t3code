import { assert, it } from "@effect/vitest";

import {
  parseProcStatParentPid,
  parseProcStatusBytes,
  processTreePids,
} from "./dev-memory-limit.ts";

it("counts RAM and swap for the dev runner's descendants only", () => {
  assert.strictEqual(parseProcStatParentPid("812 (node (vite) 2) S 77 812 812 0 -1"), 77);
  assert.strictEqual(
    parseProcStatusBytes("Name:\tnode\nVmRSS:\t   2048 kB\nVmSwap:\t  1024 kB\nThreads:\t9\n"),
    3 * 1024 * 1024,
  );
  // Listed before its parent, as /proc may order them.
  const processes = [
    { pid: 30, ppid: 20 },
    { pid: 20, ppid: 10 },
    { pid: 11, ppid: 1 },
    { pid: 10, ppid: 1 },
  ];
  assert.deepStrictEqual([...processTreePids(10, processes)].sort(), [10, 20, 30]);
});
