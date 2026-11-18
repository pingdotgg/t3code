import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readUsageBudget } from "./usageBudget.ts";

const STATUS = {
  state: "soft",
  hour: { costUsd: 28.5, softLimitUsd: 27, hardLimitUsd: 30 },
  day: {
    costUsd: 118.02,
    softLimitUsd: 180,
    hardLimitUsd: 200,
    resetsAt: "2026-11-19T05:00:00.000Z",
  },
  overrideUntil: null,
  cacheHitPercent: 81.4,
};

const printing = (stdout: string, exitCode = 0, stderr = "") => [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`,
];

describe("readUsageBudget", () => {
  it.effect("decodes the status the command prints", () =>
    Effect.gen(function* () {
      expect(yield* readUsageBudget(printing(JSON.stringify(STATUS)))).toEqual(STATUS);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads no budget when no command is set", () =>
    Effect.gen(function* () {
      expect(yield* readUsageBudget([])).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with the command's stderr when it exits with an error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readUsageBudget(printing("", 1, "config is invalid\n")));
      expect(error.detail).toBe(`${process.execPath} exited with 1: config is invalid`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the command prints an unknown status", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readUsageBudget(printing(`{"state":"calm"}`)));
      expect(error.detail).toBe(`${process.execPath} printed an unknown status`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
