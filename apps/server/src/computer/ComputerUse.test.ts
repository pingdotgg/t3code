import { describe, expect, it } from "@effect/vitest";
import { ComputerUseConsentError, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import { ComputerUse, layer, locatePoint, renderScreenshot } from "./ComputerUse.ts";
import { decodePng, encodePng } from "./desktopImage.ts";
import { KdeDesktop } from "./KdeDesktop.ts";
import { PortalCallError, type RemoteDesktopSession } from "./RemoteDesktopPortal.ts";

const threadA = ThreadId.make("thread-computer-a");
const threadB = ThreadId.make("thread-computer-b");
const left = { nodeId: 1, x: 0, y: 0, width: 200, height: 100 };
const right = { nodeId: 2, x: 200, y: 0, width: 200, height: 100 };

const png = (width: number, height: number, value = 0) =>
  encodePng({ width, height, data: new Uint8Array(width * height * 3).fill(value) });
const wholeDesktop = { x: 0, y: 0, width: 400, height: 100 };

const harness = (options: {
  readonly enabled?: boolean;
  readonly firstOpen?: "cancelled";
  readonly failKeyPress?: number;
}) =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const opens: Array<string | null> = [];
    const closes = yield* Queue.unbounded<number>();
    const ends: Array<Deferred.Deferred<void>> = [];
    const record = (event: string) => Effect.sync(() => void events.push(event));
    const makeSession = (index: number): RemoteDesktopSession => {
      const ended = Deferred.makeUnsafe<void>();
      ends.push(ended);
      return {
        // The portal lists streams in its own order; display indexes go left to right.
        streams: [right, left],
        restoreToken: `token-${index}`,
        closed: Deferred.await(ended),
        pointerMotionAbsolute: (stream, x, y) => record(`move ${stream.nodeId} ${x} ${y}`),
        pointerButton: (button, pressed) =>
          record(`button ${button.toString(16)} ${pressed ? "down" : "up"}`),
        pointerAxis: (dx, dy) => record(`axis ${dx} ${dy}`),
        keyboardKeysym: (keysym, pressed) =>
          pressed && keysym === options.failKeyPress
            ? Effect.fail(
                new PortalCallError({ member: "NotifyKeyboardKeysym", cause: "rejected" }),
              )
            : record(`key ${keysym.toString(16)} ${pressed ? "down" : "up"}`),
        close: Effect.suspend(() => {
          Deferred.doneUnsafe(ended, Effect.void);
          return Queue.offer(closes, index);
        }).pipe(Effect.asVoid),
      };
    };
    const desktop = Layer.succeed(
      KdeDesktop,
      KdeDesktop.of({
        unavailableReason: Effect.succeed(null),
        openSession: (restoreToken) =>
          Effect.suspend(() => {
            opens.push(restoreToken);
            return opens.length === 1 && options.firstOpen === "cancelled"
              ? Effect.fail(new ComputerUseConsentError({ outcome: "cancelled" }))
              : Effect.succeed(makeSession(opens.length));
          }),
        capture: Effect.succeed({ png: png(400, 100), bounds: wholeDesktop }),
      }),
    );
    const services = layer.pipe(
      Layer.provide(desktop),
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          enableAgentComputerAccess: options.enabled ?? true,
        }),
      ),
    );
    return {
      events,
      opens,
      takeClose: Queue.take(closes),
      endFromDesktop: (session: number) => Deferred.doneUnsafe(ends[session - 1]!, Effect.void),
      services,
    };
  });

const click = (threadId: ThreadId, x: number, y: number) =>
  ComputerUse.use((computer) => computer.act({ threadId, action: "click", x, y }));

describe("ComputerUse", () => {
  it.effect("keeps one thread in control and clicks on the display under the pixel", () =>
    Effect.gen(function* () {
      const test = yield* harness({});
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const early = yield* Effect.flip(click(threadA, 10, 10));
        expect(early.message).toContain("Call `computer_screenshot` first");

        const shot = yield* computer.screenshot({ threadId: threadA });
        expect(shot.displays).toEqual([
          { index: 0, x: 0, y: 0, width: 200, height: 100 },
          { index: 1, x: 200, y: 0, width: 200, height: 100 },
        ]);
        expect(shot.screenshot).toMatchObject({ width: 400, height: 100 });
        const other = yield* Effect.flip(computer.screenshot({ threadId: threadB }));
        expect(other.message).toContain("Another T3 thread is controlling this desktop");

        yield* click(threadA, 250, 10);
        expect(test.events.splice(0)).toEqual([
          "move 2 50.5 10.5",
          "button 110 down",
          "button 110 up",
        ]);
        yield* computer.screenshot({ threadId: threadA, display: 1 });
        yield* computer.act({ threadId: threadA, action: "drag", x: 0, y: 0, toX: 10, toY: 20 });
        yield* computer.act({ threadId: threadA, action: "scroll", scrollY: 2 });
        yield* computer.act({ threadId: threadA, action: "key", keys: "ctrl+a" });
        expect(test.events.splice(0)).toEqual([
          "move 2 0.5 0.5",
          "button 110 down",
          "move 2 5.5 10.5",
          "move 2 10.5 20.5",
          "button 110 up",
          "axis 0 -30",
          "key ffe3 down",
          "key 61 down",
          "key 61 up",
          "key ffe3 up",
        ]);
        const outside = yield* Effect.flip(click(threadA, 200, 10));
        expect(outside.message).toBe("(200, 10) is outside the last screenshot, which is 200x100.");
        expect(test.events).toEqual([]);

        expect(yield* computer.stop({ threadId: threadB, forget: false })).toEqual({
          stopped: false,
        });
        expect(yield* computer.stop({ threadId: threadA, forget: false })).toEqual({
          stopped: true,
        });
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, "token-1"]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("releases held modifiers when a key press fails", () =>
    Effect.gen(function* () {
      const test = yield* harness({ failKeyPress: 0x74 });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        yield* computer.screenshot({ threadId: threadA });
        const error = yield* Effect.flip(
          computer.act({ threadId: threadA, action: "key", keys: "ctrl+shift+t" }),
        );
        expect(error).toMatchObject({ _tag: "ComputerUseOperationError", operation: "input" });
        expect(test.events).toEqual([
          "key ffe3 down",
          "key ffe1 down",
          "key ffe1 up",
          "key ffe3 up",
        ]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("tells the thread once when the user ends control, and asks again next time", () =>
    Effect.gen(function* () {
      const test = yield* harness({});
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        yield* computer.screenshot({ threadId: threadA });
        test.endFromDesktop(1);
        expect(yield* test.takeClose).toBe(1);
        const ended = yield* Effect.flip(click(threadA, 1, 1));
        expect(ended).toMatchObject({ _tag: "ComputerUseConsentError", outcome: "ended" });
        const after = yield* Effect.flip(click(threadA, 1, 1));
        expect(after.message).toContain("Call `computer_screenshot` first");
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, null]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("ends idle control after ten minutes and keeps the grant", () =>
    Effect.gen(function* () {
      const test = yield* harness({});
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        yield* computer.screenshot({ threadId: threadA });
        yield* TestClock.adjust("10 minutes");
        expect(yield* test.takeClose).toBe(1);
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, "token-1"]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("frees the desktop when the user declines", () =>
    Effect.gen(function* () {
      const test = yield* harness({ firstOpen: "cancelled" });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const declined = yield* Effect.flip(computer.screenshot({ threadId: threadA }));
        expect(declined).toMatchObject({ outcome: "cancelled" });
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, null]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("refuses while the setting is off without opening a session", () =>
    Effect.gen(function* () {
      const test = yield* harness({ enabled: false });
      const error = yield* ComputerUse.use((computer) =>
        Effect.flip(computer.screenshot({ threadId: threadA })),
      ).pipe(Effect.provide(test.services));
      expect(error.message).toContain("Settings > Devices");
      expect(test.opens).toEqual([]);
    }),
  );

  it("maps physical capture pixels to logical display coordinates", () => {
    // A 2x display: the capture is twice the logical size.
    const shot = renderScreenshot({ png: png(800, 200), bounds: wholeDesktop }, [left, right], 1);
    expect(shot.frame).toEqual({
      originX: 200,
      originY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      width: 400,
      height: 200,
    });
    expect(decodePng(shot.png)).toMatchObject({ width: 400, height: 200 });
    expect(locatePoint(shot.frame, [left, right], 399, 199)).toEqual({
      stream: right,
      x: 199.75,
      y: 99.75,
    });
  });

  it("shows only the screens the user shared", () => {
    const capture = { png: png(400, 100, 255), bounds: wholeDesktop };
    const onlyRight = renderScreenshot(capture, [right], undefined);
    expect(onlyRight.frame).toMatchObject({ originX: 200, width: 200, height: 100 });

    // A shorter screen leaves a corner of the shared area that no screen covers.
    const short = { ...right, height: 50 };
    const shot = renderScreenshot(capture, [left, short], undefined);
    const image = decodePng(shot.png);
    const pixel = (x: number, y: number) => image.data[(y * image.width + x) * 3];
    expect([pixel(10, 80), pixel(300, 10), pixel(300, 80)]).toEqual([255, 255, 0]);
    expect(locatePoint(shot.frame, [left, short], 300, 80)).toBe(
      "(300, 80) is not on a shared display.",
    );
  });
});
