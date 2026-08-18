import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type NotificationDecidedEdge,
  type NotificationStreamItem,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type * as DesktopNotifications from "./DesktopNotifications.ts";
import { deliverNotificationStream } from "./DesktopNotificationWatcher.ts";

const THREAD_ID = ThreadId.make("thread-1");

function makeEdge(sequence: number): NotificationDecidedEdge {
  const turnId = TurnId.make(`turn-${sequence}`);
  return {
    identityKey: `t3:notif:${THREAD_ID}:turn-completed:${turnId}`,
    kind: "turn-completed",
    threadId: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    turnId,
    requestId: null,
    projectTitle: "t3",
    threadTitle: `Thread ${sequence}`,
    headline: "Turn complete",
    detail: null,
    triggeringEventId: EventId.make(`event-${sequence}`),
    triggeringSequence: sequence,
    previousPhase: "running",
    nextPhase: "completed",
    detectedAt: "2026-08-06T00:00:00.000Z",
  };
}

function edgeItem(sequence: number): NotificationStreamItem {
  return { kind: "edge", edge: makeEdge(sequence) };
}

function makeDriver(
  outcomes: ReadonlyArray<DesktopNotifications.DesktopNotificationDeliveryOutcome>,
) {
  const reported: Array<{ identityKey: string; outcome: string }> = [];
  let index = 0;
  return {
    reported,
    show: () =>
      Effect.sync(() => {
        const outcome = outcomes[index] ?? "shown";
        index += 1;
        return outcome;
      }),
    report: (input: { readonly identityKey: string; readonly outcome: string }) =>
      Effect.sync(() => {
        reported.push({ identityKey: input.identityKey, outcome: input.outcome });
      }),
  };
}

describe("deliverNotificationStream", () => {
  it.effect("reports what the transport did with every edge it saw", () =>
    Effect.gen(function* () {
      const driver = makeDriver(["shown", "suppressed:focused"]);
      const resumeSequenceRef = yield* Ref.make(Option.none<number>());

      yield* deliverNotificationStream({
        items: Stream.fromIterable([edgeItem(4), edgeItem(7)]),
        show: driver.show,
        report: driver.report,
        resumeSequenceRef,
      });

      assert.deepStrictEqual(driver.reported, [
        { identityKey: makeEdge(4).identityKey, outcome: "shown" },
        { identityKey: makeEdge(7).identityKey, outcome: "suppressed:focused" },
      ]);
    }),
  );

  it.effect("keeps transport-local outcomes off the wire", () =>
    Effect.gen(function* () {
      const driver = makeDriver(["duplicate", "unsupported", "failed"]);
      const resumeSequenceRef = yield* Ref.make(Option.none<number>());

      yield* deliverNotificationStream({
        items: Stream.fromIterable([edgeItem(1), edgeItem(2), edgeItem(3)]),
        show: driver.show,
        report: driver.report,
        resumeSequenceRef,
      });

      assert.deepStrictEqual(driver.reported, []);
    }),
  );

  it.effect("remembers the highest sequence it presented, not the last", () =>
    Effect.gen(function* () {
      const driver = makeDriver(["shown", "shown", "shown"]);
      const resumeSequenceRef = yield* Ref.make(Option.none<number>());

      yield* deliverNotificationStream({
        // Out of order on purpose: the resume point must not regress, or a
        // reconnect would re-deliver edges this process already presented.
        items: Stream.fromIterable([edgeItem(2), edgeItem(9), edgeItem(5)]),
        show: driver.show,
        report: driver.report,
        resumeSequenceRef,
      });

      assert.deepStrictEqual(yield* Ref.get(resumeSequenceRef), Option.some(9));
    }),
  );

  it.effect("advances the resume point even for an edge it chose not to show", () =>
    Effect.gen(function* () {
      const driver = makeDriver(["suppressed:disabled"]);
      const resumeSequenceRef = yield* Ref.make(Option.none<number>());

      yield* deliverNotificationStream({
        items: Stream.fromIterable([edgeItem(3)]),
        show: driver.show,
        report: driver.report,
        resumeSequenceRef,
      });

      assert.deepStrictEqual(yield* Ref.get(resumeSequenceRef), Option.some(3));
    }),
  );

  it.effect("ignores the catch-up marker", () =>
    Effect.gen(function* () {
      const driver = makeDriver([]);
      const resumeSequenceRef = yield* Ref.make(Option.none<number>());

      yield* deliverNotificationStream({
        items: Stream.fromIterable<NotificationStreamItem>([{ kind: "synchronized" }]),
        show: driver.show,
        report: driver.report,
        resumeSequenceRef,
      });

      assert.deepStrictEqual(driver.reported, []);
      assert.isTrue(Option.isNone(yield* Ref.get(resumeSequenceRef)));
    }),
  );
});
