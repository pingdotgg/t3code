import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectWindowsChildPids } from "./win32.ts";

function parentPidFromCommand(command: string | undefined): number {
  return Number(/ParentProcessId = (\d+)/.exec(command ?? "")?.[1] ?? "0");
}

describe("process.collectWindowsChildPids", () => {
  it.effect("walks the full descendant tree breadth-first", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const childMap = new Map<number, string>([
        [100, "200\n300\n"],
        [200, "400\n"],
        [300, ""],
        [400, ""],
      ]);

      const childPids = yield* collectWindowsChildPids(100, (input) => {
        const command = input.args[3] ?? "";
        commands.push(command);
        return Effect.succeed({
          stdout: childMap.get(parentPidFromCommand(command)) ?? "",
          stderr: "",
          exitCode: 0,
        });
      });

      assert.deepStrictEqual(childPids, [200, 300, 400]);
      assert.equal(commands.length, 4);
    }),
  );

  it.effect("deduplicates repeated descendants to avoid traversal loops", () =>
    Effect.gen(function* () {
      const childMap = new Map<number, string>([
        [100, "200\n300\n"],
        [200, "300\n400\n"],
        [300, "200\n"],
        [400, ""],
      ]);

      const childPids = yield* collectWindowsChildPids(100, (input) => {
        const parentPid = parentPidFromCommand(input.args[3]);
        return Effect.succeed({
          stdout: childMap.get(parentPid) ?? "",
          stderr: "",
          exitCode: 0,
        });
      });

      assert.deepStrictEqual(childPids, [200, 300, 400]);
    }),
  );
});
