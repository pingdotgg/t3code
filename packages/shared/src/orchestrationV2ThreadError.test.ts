import type { OrchestrationV2Run } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { latestRunNotWaitingOnUser } from "./orchestrationV2ThreadError.ts";

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
) => ({ id: `run-${ordinal}`, ordinal, status, ...extra }) as OrchestrationV2Run;

describe("latestRunNotWaitingOnUser", () => {
  it("skips queued runs at or behind a message being edited", () => {
    expect(
      latestRunNotWaitingOnUser([
        run(1, "completed"),
        run(2, "queued", { editing: true }),
        run(3, "queued"),
      ])?.id,
    ).toBe("run-1");
  });

  it("keeps queued runs ahead of a message being edited", () => {
    expect(
      latestRunNotWaitingOnUser([
        run(1, "completed"),
        run(2, "queued"),
        run(3, "queued", { editing: true }),
      ])?.id,
    ).toBe("run-2");
  });

  it("skips held queued runs", () => {
    expect(
      latestRunNotWaitingOnUser([run(1, "completed"), run(2, "queued", { queueHeld: true })])?.id,
    ).toBe("run-1");
  });

  it.each([
    [
      "a queued message moved to the head and being edited",
      [
        run(1, "completed"),
        run(2, "queued", { queuePosition: 2 }),
        run(3, "queued", { editing: true, queuePosition: 1 }),
      ],
      "run-1",
    ],
    [
      "a queued message moved ahead of the edited one",
      [
        run(1, "completed"),
        run(2, "queued", { editing: true, queuePosition: 3 }),
        run(3, "queued", { queuePosition: 1 }),
      ],
      "run-3",
    ],
    [
      "a queued message tied with the edited position",
      [
        run(1, "completed"),
        run(2, "queued", { editing: true, queuePosition: 1 }),
        run(3, "queued", { queuePosition: 1 }),
      ],
      "run-1",
    ],
    [
      "an edited message without a position beside a positioned one",
      [
        run(1, "completed"),
        run(2, "queued", { editing: true }),
        run(3, "queued", { queuePosition: 1 }),
      ],
      "run-3",
    ],
  ] as const)("orders by queue position: %s", (_case, runs, expected) => {
    expect(
      latestRunNotWaitingOnUser(runs as unknown as ReadonlyArray<OrchestrationV2Run>)?.id,
    ).toBe(expected);
  });
});
