import { describe, expect, it } from "vite-plus/test";

import {
  drainBlockedPreparedRunQueuePosition,
  queuedRunsInDeliveryOrder,
  selectStartableQueuedRun,
} from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });

  it("lets a registered save-work turn start ahead of earlier drain-blocked runs", () => {
    const ordinary = {
      id: "run:ordinary",
      ordinal: 1,
      queuePosition: 1,
      status: "queued",
      userMessageId: "message:ordinary",
    } as never;
    const saveWork = {
      id: "run:save-work",
      ordinal: 2,
      queuePosition: 2,
      status: "queued",
      userMessageId: "message:graceful-shutdown-save",
    } as never;
    const laterOrdinary = {
      id: "run:later-ordinary",
      ordinal: 3,
      queuePosition: 3,
      status: "queued",
      userMessageId: "message:later-ordinary",
    } as never;

    expect(
      selectStartableQueuedRun([ordinary, saveWork, laterOrdinary], {
        isDrainBlocked: (run) => run.id !== "run:save-work",
        isSaveWorkMessage: (messageId) => messageId === "message:graceful-shutdown-save",
      })?.id,
    ).toBe("run:save-work");

    expect(
      selectStartableQueuedRun([ordinary, laterOrdinary], {
        isDrainBlocked: () => true,
        isSaveWorkMessage: () => false,
      }),
    ).toBeUndefined();
  });

  it("keeps a drain-blocked prepared run ahead of later ordinary queued turns", () => {
    const prepared = { queuePosition: null, ordinal: 1 };
    const laterQueued = {
      id: "run:later",
      ordinal: 2,
      queuePosition: 1,
      status: "queued",
      userMessageId: "message:later",
    };
    const requeued = {
      id: "run:prepared",
      ordinal: prepared.ordinal,
      queuePosition: drainBlockedPreparedRunQueuePosition(prepared, [laterQueued]),
      status: "queued",
      userMessageId: "message:prepared",
    };
    expect(
      queuedRunsInDeliveryOrder({
        messages: [{ id: "message:prepared" }, { id: "message:later" }],
        runs: [laterQueued, requeued],
      } as never).map((run) => run.id),
    ).toEqual(["run:prepared", "run:later"]);
  });

  it("keeps a high-ordinal prepared run ahead of compact later queue positions", () => {
    const prepared = { queuePosition: null, ordinal: 5 };
    const laterQueued = {
      id: "run:later",
      ordinal: 6,
      queuePosition: 1,
      status: "queued",
      userMessageId: "message:later",
    };
    const requeued = {
      id: "run:prepared",
      ordinal: prepared.ordinal,
      queuePosition: drainBlockedPreparedRunQueuePosition(prepared, [laterQueued]),
      status: "queued",
      userMessageId: "message:prepared",
    };
    expect(requeued.queuePosition).toBe(1);
    expect(
      queuedRunsInDeliveryOrder({
        messages: [{ id: "message:prepared" }, { id: "message:later" }],
        runs: [laterQueued, requeued],
      } as never).map((run) => run.id),
    ).toEqual(["run:prepared", "run:later"]);
  });
});
