import { describe, expect, it } from "@effect/vitest";

import { commandOutputProgress } from "./commandOutputProgress.ts";

describe("commandOutputProgress", () => {
  it.each([
    [
      "a test runner count",
      " ✓ guard.spec.ts (4)\n❯ refresh.spec.ts 24/31",
      { completed: 24, total: 31 },
    ],
    ["a bracketed step", "[3/10] RUN pnpm install\n", { completed: 3, total: 10 }],
    ["a spaced count", "Building (120 / 300) crates", { completed: 120, total: 300 }],
    ["a percentage", "webpack 42% building modules", { completed: 42, total: 100 }],
    ["a pytest percentage", "tests/test_auth.py ....    [ 87%]", { completed: 87, total: 100 }],
    [
      "the last redraw of a carriage-return progress bar",
      "Downloading  10%\rDownloading  55%\rDownloading  73%\r\n",
      { completed: 73, total: 100 },
    ],
    [
      "colored output",
      "\u001b[32m✓\u001b[0m \u001b[1m17/40\u001b[0m tests",
      { completed: 17, total: 40 },
    ],
    [
      "the newest of several lines",
      "1/10 setup\n2/10 build\n7/10 test\n",
      { completed: 7, total: 10 },
    ],
  ])("reads %s", (_name, output, expected) => {
    expect(commandOutputProgress(output)).toEqual(expected);
  });

  it.each([
    ["no output", undefined],
    ["a path", "wrote dist/assets/12/34.js"],
    ["a date", "Released 2024/11/05"],
    ["a version range", "react 18.3/19.0 compatible"],
    ["a count past its total", "retry 5/3"],
    ["a count that scrolled out of the tail", "3/10 build\n" + "log line\n".repeat(10)],
  ])("ignores %s", (_name, output) => {
    expect(commandOutputProgress(output)).toBeUndefined();
  });
});
