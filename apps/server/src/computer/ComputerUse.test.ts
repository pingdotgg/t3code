import { describe, expect, it } from "@effect/vitest";
import {
  ComputerUseConsentError,
  ComputerUseOperationError,
  ThreadId,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
const layout = (scale: number, screens = [left, right]) => ({
  bounds: wholeDesktop,
  scale,
  screens,
});

const harness = (options: {
  readonly enabled?: boolean;
  readonly firstOpen?: "cancelled" | "pending" | "answered later";
  readonly holdCapture?: boolean;
  readonly failKeyPress?: number;
  readonly failKeyRelease?: number;
  readonly failCaptures?: number;
}) =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const dialogShown = yield* Deferred.make<void>();
    const dialogAnswer = yield* Deferred.make<void>();
    const sessionOpened = yield* Deferred.make<void>();
    const captureStarted = yield* Deferred.make<void>();
    const captureReleased = yield* Deferred.make<void>();
    if (!options.holdCapture) Deferred.doneUnsafe(captureReleased, Effect.void);
    let failCaptures = options.failCaptures ?? 0;
    const opens: Array<string | null> = [];
    const closes = yield* Queue.unbounded<number>();
    const ends: Array<Deferred.Deferred<void>> = [];
    const record = (event: string) => Effect.sync(() => void events.push(event));
    const makeSession = (index: number): RemoteDesktopSession => {
      const ended = Deferred.makeUnsafe<void>();
      ends.push(ended);
      let closed = false;
      return {
        // The portal lists streams in its own order; display indexes go left to right.
        streams: [right, left],
        restoreToken: `token-${index}`,
        closed: Deferred.await(ended),
        isClosed: Deferred.isDone(ended),
        pointerMotionAbsolute: (stream, x, y) => record(`move ${stream.nodeId} ${x} ${y}`),
        pointerButton: (button, pressed) =>
          record(`button ${button.toString(16)} ${pressed ? "down" : "up"}`),
        pointerAxis: (dx, dy) => record(`axis ${dx} ${dy}`),
        keyboardKeysym: (keysym, pressed) =>
          keysym === (pressed ? options.failKeyPress : options.failKeyRelease)
            ? Effect.fail(
                new PortalCallError({ member: "NotifyKeyboardKeysym", cause: "rejected" }),
              )
            : record(`key ${keysym.toString(16)} ${pressed ? "down" : "up"}`),
        // Idempotent, like the portal's.
        close: Effect.suspend(() => {
          Deferred.doneUnsafe(ended, Effect.void);
          if (closed) return Effect.void;
          closed = true;
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
            if (opens.length > 1 || options.firstOpen === undefined) {
              return Effect.succeed(makeSession(opens.length));
            }
            if (options.firstOpen === "cancelled") {
              return Effect.fail(new ComputerUseConsentError({ outcome: "cancelled" }));
            }
            if (options.firstOpen === "answered later") {
              // Like the portal, a session that is never handed over gets closed.
              return Deferred.succeed(dialogShown, undefined).pipe(
                Effect.andThen(Deferred.await(dialogAnswer)),
                Effect.andThen(Effect.sync(() => makeSession(1))),
                Effect.flatMap((session) =>
                  Deferred.succeed(sessionOpened, undefined).pipe(
                    Effect.as(session),
                    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : session.close)),
                  ),
                ),
              );
            }
            // A consent dialog nobody answers; interrupting it is how the portal closes it.
            return Deferred.succeed(dialogShown, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => record("dialog closed")),
            );
          }),
        capture: Deferred.succeed(captureStarted, undefined).pipe(
          Effect.andThen(Deferred.await(captureReleased)),
          Effect.onInterrupt(() => record("capture interrupted")),
          Effect.andThen(
            Effect.suspend(() =>
              failCaptures-- > 0
                ? Effect.fail(
                    new ComputerUseOperationError({ operation: "screenshot", cause: "spectacle" }),
                  )
                : Effect.succeed({ png: png(400, 100), ...layout(1) }),
            ),
          ),
        ),
      }),
    );
    // layerTest never emits changes; the service needs them to see the setting turn off.
    const settings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const base = yield* ServerSettings.ServerSettingsService;
        const changes = yield* PubSub.unbounded<Settings>();
        return ServerSettings.ServerSettingsService.of({
          ...base,
          updateSettings: (patch) =>
            base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
        });
      }),
    ).pipe(
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          enableAgentComputerAccess: options.enabled ?? true,
        }),
      ),
    );
    const services = layer.pipe(Layer.provide(desktop), Layer.provideMerge(settings));
    return {
      events,
      opens,
      dialogShown: Deferred.await(dialogShown),
      /** The user allows the dialog; resolves once the portal has handed over the session. */
      answerDialog: Deferred.succeed(dialogAnswer, undefined).pipe(
        Effect.andThen(Deferred.await(sessionOpened)),
      ),
      captureStarted: Deferred.await(captureStarted),
      releaseCapture: Deferred.succeed(captureReleased, undefined),
      takeClose: Queue.take(closes),
      endFromDesktop: (session: number) => Deferred.doneUnsafe(ends[session - 1]!, Effect.void),
      services,
    };
  });

/** The error a call failed with, or a test failure naming what it returned instead. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected the call to fail, but it succeeded.");
  return Cause.squash(exit.cause);
};

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

  it.effect("releases held modifiers and ends control when a key release fails", () =>
    Effect.gen(function* () {
      const test = yield* harness({ failKeyRelease: 0x74 });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        yield* computer.screenshot({ threadId: threadA });
        const error = yield* Effect.flip(
          computer.act({ threadId: threadA, action: "key", keys: "ctrl+t" }),
        );
        expect(error).toMatchObject({ _tag: "ComputerUseOperationError", operation: "input" });
        expect(test.events).toEqual(["key ffe3 down", "key 74 down", "key ffe3 up"]);
        // Ending the session makes the desktop drop the stuck key.
        expect(yield* test.takeClose).toBe(1);
        const next = yield* Effect.flip(click(threadA, 1, 1));
        expect(next.message).toContain("Call `computer_screenshot` first");
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("ends idle control after ten minutes and keeps the grant", () =>
    Effect.gen(function* () {
      const test = yield* harness({});
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        // A first screenshot that fails still started a session, which must not outlive idling.
        const invalid = yield* Effect.flip(computer.screenshot({ threadId: threadA, display: 2 }));
        expect(invalid.message).toBe("There is no display 2. Displays are 0 to 1.");
        yield* TestClock.adjust("10 minutes");
        expect(yield* test.takeClose).toBe(1);
        yield* computer.screenshot({ threadId: threadB });
        yield* TestClock.adjust("10 minutes");
        expect(yield* test.takeClose).toBe(2);
        expect(test.opens).toEqual([null, "token-1"]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("frees the desktop when the first screenshot cannot capture", () =>
    Effect.gen(function* () {
      const test = yield* harness({ failCaptures: 1 });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const failed = yield* Effect.flip(computer.screenshot({ threadId: threadA }));
        expect(failed).toMatchObject({
          _tag: "ComputerUseOperationError",
          operation: "screenshot",
        });
        expect(yield* test.takeClose).toBe(1);
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, "token-1"]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("turning the setting off closes an unanswered prompt and refuses queued calls", () =>
    Effect.gen(function* () {
      const test = yield* harness({ firstOpen: "pending" });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const settings = yield* ServerSettings.ServerSettingsService;
        const pending = yield* Effect.forkChild(
          Effect.flip(computer.screenshot({ threadId: threadA })),
        );
        yield* test.dialogShown;
        const queued = yield* Effect.forkChild(
          Effect.flip(computer.screenshot({ threadId: threadA })),
        );
        yield* settings.updateSettings({ enableAgentComputerAccess: false });
        expect((yield* Fiber.join(pending)).message).toContain("Settings > Devices");
        expect(test.events).toEqual(["dialog closed"]);
        expect((yield* Fiber.join(queued)).message).toContain("Settings > Devices");
        expect(test.opens).toEqual([null]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("stopping closes this thread's unanswered prompt", () =>
    Effect.gen(function* () {
      const test = yield* harness({ firstOpen: "pending" });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const pending = yield* Effect.forkChild(
          Effect.flip(computer.screenshot({ threadId: threadA })),
        );
        yield* test.dialogShown;
        expect(yield* computer.stop({ threadId: threadB, forget: false })).toEqual({
          stopped: false,
        });
        expect(test.events).toEqual([]);
        expect(yield* computer.stop({ threadId: threadA, forget: false })).toEqual({
          stopped: true,
        });
        expect(test.events).toEqual(["dialog closed"]);
        expect((yield* Fiber.join(pending)).message).toContain("stopped");
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, null]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect("stopping after the user allowed, before control started, still ends it", () =>
    Effect.gen(function* () {
      const test = yield* harness({ firstOpen: "answered later" });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse;
        const pending = yield* Effect.forkChild(
          Effect.exit(computer.screenshot({ threadId: threadA })),
        );
        yield* test.dialogShown;
        // Stops while the portal hands over the session the user allowed.
        yield* test.answerDialog;
        expect(yield* computer.stop({ threadId: threadA, forget: true })).toEqual({
          stopped: true,
        });
        expect(failureOf(yield* Fiber.join(pending))).toMatchObject({
          message: expect.stringContaining("stopped"),
        });
        expect(yield* test.takeClose).toBe(1);
        // Nobody holds the desktop, and the grant was forgotten as asked.
        yield* computer.screenshot({ threadId: threadB });
        expect(test.opens).toEqual([null, null]);
      }).pipe(Effect.provide(test.services));
    }),
  );

  it.effect.each(["the setting turns off", "the user ends it"] as const)(
    "returns no screenshot when %s during the capture",
    (revocation) =>
      Effect.gen(function* () {
        const test = yield* harness({ holdCapture: true });
        yield* Effect.gen(function* () {
          const computer = yield* ComputerUse;
          const settings = yield* ServerSettings.ServerSettingsService;
          const pending = yield* Effect.forkChild(
            Effect.exit(computer.screenshot({ threadId: threadA })),
          );
          yield* test.captureStarted;
          if (revocation === "the setting turns off") {
            yield* settings.updateSettings({ enableAgentComputerAccess: false });
          } else {
            test.endFromDesktop(1);
          }
          // Even a capture that finishes after the revocation must not reach the agent.
          yield* test.releaseCapture;
          expect(failureOf(yield* Fiber.join(pending))).toMatchObject(
            revocation === "the setting turns off"
              ? { _tag: "ComputerUseUnavailableError", reason: expect.stringContaining("Settings") }
              : { _tag: "ComputerUseConsentError", outcome: "ended" },
          );
          expect(yield* test.takeClose).toBe(1);
          const next = yield* Effect.flip(click(threadA, 1, 1));
          expect(next.message).toMatch(/Settings > Devices|Call `computer_screenshot` first/);
          yield* settings.updateSettings({ enableAgentComputerAccess: true });
          // Both revocations drop the saved grant, and free the desktop for another thread.
          yield* computer.screenshot({ threadId: threadB });
          expect(test.opens).toEqual([null, null]);
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
    const shot = renderScreenshot({ png: png(800, 200), ...layout(2) }, [left, right], 1);
    if (typeof shot === "string") throw new Error(shot);
    expect(shot.frame).toMatchObject({
      originX: 200,
      originY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      width: 400,
      height: 200,
    });
    expect(decodePng(shot.png)).toMatchObject({ width: 400, height: 200 });
    expect(locatePoint(shot.frame, 399, 199)).toEqual({
      stream: right,
      x: 199.75,
      y: 99.75,
    });
  });

  it.each([
    ["an image at another scale", png(400, 100), layout(2), [left, right]],
    ["a stream on no current screen", png(400, 100), layout(1), [left, { ...right, x: 210 }]],
  ])("refuses a capture that does not line up: %s", (_, image, capturedLayout, streams) => {
    expect(renderScreenshot({ png: image, ...capturedLayout }, streams, undefined)).toContain(
      "The screen layout changed",
    );
  });

  it("shows only the screens the user shared", () => {
    const capture = { png: png(400, 100, 255), ...layout(1) };
    const onlyRight = renderScreenshot(capture, [right], undefined);
    if (typeof onlyRight === "string") throw new Error(onlyRight);
    expect(onlyRight.frame).toMatchObject({ originX: 200, width: 200, height: 100 });

    // A shorter screen leaves a corner of the shared area that no screen covers.
    const short = { ...right, height: 50 };
    const shot = renderScreenshot(
      { ...capture, ...layout(1, [left, short]) },
      [left, short],
      undefined,
    );
    if (typeof shot === "string") throw new Error(shot);
    const image = decodePng(shot.png);
    const pixel = (x: number, y: number) => image.data[(y * image.width + x) * 3];
    expect([pixel(10, 80), pixel(300, 10), pixel(300, 80)]).toEqual([255, 255, 0]);
    expect(locatePoint(shot.frame, 300, 80)).toBe("(300, 80) is not on a shared display.");
  });

  it.each([
    ["a pixel wider and taller than", { nodeId: 2, x: 799, y: 0, width: 801, height: 101 }],
    ["a pixel off in both axes from", { nodeId: 2, x: 801, y: 1, width: 800, height: 100 }],
  ])("keeps a stream %s its screen inside it", (_, stream) => {
    // 2x screens, so the screenshot is downscaled. Only the red top-right one is shared.
    const screens = [
      { x: 0, y: 0, width: 800, height: 100 },
      { x: 800, y: 0, width: 800, height: 100 },
      { x: 0, y: 100, width: 1600, height: 100 },
    ];
    const width = 3200;
    const height = 400;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++)
        data[(y * width + x) * 3 + (x >= 1600 && y < 200 ? 0 : 1)] = 255;
    }
    const shot = renderScreenshot(
      {
        png: encodePng({ width, height, data }),
        bounds: { x: 0, y: 0, width: 1600, height: 200 },
        scale: 2,
        screens,
      },
      [stream],
      undefined,
    );
    if (typeof shot === "string") throw new Error(shot);
    const image = decodePng(shot.png);
    expect(image.width).toBeLessThan(1600);
    expect(image.data.filter((_, index) => index % 3 === 1).some((value) => value > 0)).toBe(false);
    // Clicks stay on the shared screen too, even at the screenshot's edges.
    for (const [x, y] of [
      [0, 0],
      [shot.frame.width - 1, shot.frame.height - 1],
    ] as const) {
      const located = locatePoint(shot.frame, x, y);
      if (typeof located === "string") throw new Error(located);
      const globalX = located.stream.x + located.x;
      const globalY = located.stream.y + located.y;
      expect(globalX >= 800 && globalX < 1600 && globalY >= 0 && globalY < 100).toBe(true);
    }
  });

  it("never averages an unshared screen into a downscaled screenshot", () => {
    // Three 3x screens; the middle one is unshared and green, and downscaling straddles its edges.
    const screens = [
      { nodeId: 1, x: 0, y: 0, width: 320, height: 200 },
      { nodeId: 2, x: 320, y: 0, width: 301, height: 200 },
      { nodeId: 3, x: 621, y: 0, width: 379, height: 200 },
    ];
    const width = 3000;
    const height = 600;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++)
        data[(y * width + x) * 3 + (x >= 960 && x < 1863 ? 1 : 0)] = 255;
    }
    const shot = renderScreenshot(
      {
        png: encodePng({ width, height, data }),
        bounds: { x: 0, y: 0, width: 1000, height: 200 },
        scale: 3,
        screens,
      },
      [screens[0]!, screens[2]!],
      undefined,
    );
    if (typeof shot === "string") throw new Error(shot);
    const image = decodePng(shot.png);
    expect(image.width).toBeLessThan(width);
    const brightest = (channel: number) =>
      image.data.reduce(
        (max, value, index) => (index % 3 === channel ? Math.max(max, value) : max),
        0,
      );
    expect(brightest(1)).toBe(0);
    expect(brightest(0)).toBe(255);
  });
});
