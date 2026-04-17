import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { checkPosixListeningPorts } from "./posix.ts";

describe("process.checkPosixListeningPorts", () => {
  it.effect("falls back to ss when lsof exits with code 1", () =>
    Effect.gen(function* () {
      const commands: string[] = [];

      const ports = yield* checkPosixListeningPorts([123], {
        terminalPid: 123,
        platform: "linux",
        runCommand: (input) => {
          commands.push(input.command);
          if (input.command === "lsof") {
            return Effect.succeed({
              stdout: "",
              stderr: "",
              exitCode: 1,
            });
          }

          return Effect.succeed({
            stdout:
              "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n" +
              'LISTEN 0 511 127.0.0.1:3773 0.0.0.0:* users:(("node",pid=123,fd=18))\n',
            stderr: "",
            exitCode: 0,
          });
        },
      });

      assert.deepStrictEqual(ports, [3773]);
      assert.deepStrictEqual(commands, ["lsof", "ss"]);
    }),
  );

  it.effect("does not try ss on darwin when lsof reports no listening ports", () =>
    Effect.gen(function* () {
      const commands: string[] = [];

      const ports = yield* checkPosixListeningPorts([123], {
        terminalPid: 123,
        platform: "darwin",
        runCommand: (input) => {
          commands.push(input.command);
          return Effect.succeed({
            stdout: "",
            stderr: "",
            exitCode: 1,
          });
        },
      });

      assert.deepStrictEqual(ports, []);
      assert.deepStrictEqual(commands, ["lsof"]);
    }),
  );
});
