import {
  ComputerUseConsentError,
  ComputerUseInvalidActionError,
  ComputerUseOperationError,
  ComputerUseUnavailableError,
  type ComputerActInput,
  type ComputerDisplay,
  type ComputerScreenshotResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { cropAndResize, decodePng, encodePng, fitScreenshotSize } from "./desktopImage.ts";
import { KdeDesktop, type DesktopCapture, type DesktopRect } from "./KdeDesktop.ts";
import { parseKeyCombo, textKeysyms } from "./keysyms.ts";
import type { PortalCallError, PortalStream, RemoteDesktopSession } from "./RemoteDesktopPortal.ts";

type OpenSessionError = Effect.Error<ReturnType<KdeDesktop["Service"]["openSession"]>>;

const IDLE_TIMEOUT = "10 minutes";
const BUTTONS = { left: 0x110, right: 0x111, middle: 0x112 } as const;
/** Logical pixels per wheel notch, libinput's default. */
const SCROLL_STEP = 15;
/** KWin flips the portal's vertical axis before sending it to apps, so down is negative here. */
const SCROLL_DOWN_SIGN = -1;

/** How pixels in the last screenshot map to the desktop's logical coordinates. */
export interface ScreenshotFrame {
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly width: number;
  readonly height: number;
}

interface ActiveControl {
  readonly owner: ThreadId;
  readonly session: RemoteDesktopSession;
  /** Streams sorted left to right, then top to bottom; their order is the display index. */
  readonly displays: ReadonlyArray<PortalStream>;
  readonly frame: ScreenshotFrame | null;
}

interface Opening {
  readonly owner: ThreadId;
  /** Interrupting it closes the consent dialog. */
  readonly fiber: Fiber.Fiber<RemoteDesktopSession, OpenSessionError>;
}

interface ControlState {
  readonly active: ActiveControl | null;
  readonly opening: Opening | null;
  /** Lets the next session skip the dialog. Memory only, so a restart asks again. */
  readonly restoreToken: string | null;
  /** The thread whose control the user ended; its next call learns that once. */
  readonly endedFor: ThreadId | null;
}

const workspaceBounds = (displays: ReadonlyArray<DesktopRect>): DesktopRect => {
  const left = Math.min(...displays.map((display) => display.x));
  const top = Math.min(...displays.map((display) => display.y));
  const right = Math.max(...displays.map((display) => display.x + display.width));
  const bottom = Math.max(...displays.map((display) => display.y + display.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const contains = (rect: DesktopRect, x: number, y: number) =>
  x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

const matches = (a: DesktopRect, b: DesktopRect) =>
  Math.abs(a.x - b.x) <= 1 &&
  Math.abs(a.y - b.y) <= 1 &&
  Math.abs(a.width - b.width) <= 1 &&
  Math.abs(a.height - b.height) <= 1;

const layoutChanged =
  "The screen layout changed since control started. Call `computer_screenshot` again to start over.";

/**
 * Crops a whole-desktop capture to `display`, or to all shared displays, and fits it for a model.
 * Screens the user did not share come out black. Returns why when the capture does not line up
 * with the shared streams, since clicks would then land in the wrong place.
 */
export const renderScreenshot = (
  capture: DesktopCapture,
  displays: ReadonlyArray<PortalStream>,
  display: number | undefined,
) => {
  const image = decodePng(capture.png);
  const bounds = capture.bounds;
  if (
    Math.abs(image.width - bounds.width * capture.scale) > 2 * capture.scale ||
    Math.abs(image.height - bounds.height * capture.scale) > 2 * capture.scale ||
    !displays.every((shared) => capture.screens.some((screen) => matches(shared, screen)))
  ) {
    return layoutChanged;
  }
  const pixelsX = image.width / bounds.width;
  const pixelsY = image.height / bounds.height;
  const area = display === undefined ? workspaceBounds(displays) : displays[display]!;
  const left = Math.max(0, Math.min(image.width - 1, Math.round((area.x - bounds.x) * pixelsX)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round((area.y - bounds.y) * pixelsY)));
  const rect = {
    x: left,
    y: top,
    width: Math.max(1, Math.min(image.width - left, Math.round(area.width * pixelsX))),
    height: Math.max(1, Math.min(image.height - top, Math.round(area.height * pixelsY))),
  };
  // Black out unshared pixels before downscaling, so no output pixel averages any of them in.
  const shared = new Uint8Array(rect.width);
  for (let row = rect.y; row < rect.y + rect.height; row++) {
    const y = bounds.y + (row + 0.5) / pixelsY;
    shared.fill(0);
    for (const stream of displays) {
      if (y < stream.y || y >= stream.y + stream.height) continue;
      // Pixels whose centres fall inside the stream, as `contains` decides.
      const from = Math.ceil((stream.x - bounds.x) * pixelsX - 0.5) - rect.x;
      const to = Math.ceil((stream.x + stream.width - bounds.x) * pixelsX - 0.5) - rect.x;
      shared.fill(1, Math.max(0, from), Math.max(0, Math.min(rect.width, to)));
    }
    for (let column = 0; column < rect.width; column++) {
      if (shared[column] === 0) {
        const index = (row * image.width + rect.x + column) * 3;
        image.data.fill(0, index, index + 3);
      }
    }
  }
  const size = fitScreenshotSize(rect.width, rect.height);
  const frame: ScreenshotFrame = {
    originX: area.x,
    originY: area.y,
    scaleX: area.width / size.width,
    scaleY: area.height / size.height,
    width: size.width,
    height: size.height,
  };
  return { png: encodePng(cropAndResize(image, rect, size.width, size.height)), frame };
};

/** A screenshot pixel as a position inside one stream, or why it has none. */
export const locatePoint = (
  frame: ScreenshotFrame,
  displays: ReadonlyArray<PortalStream>,
  x: number,
  y: number,
): { readonly stream: PortalStream; readonly x: number; readonly y: number } | string => {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return `(${x}, ${y}) is outside the last screenshot, which is ${frame.width}x${frame.height}.`;
  }
  // Aim at the centre of the pixel, which matters once the screenshot is downscaled.
  const globalX = frame.originX + (Math.floor(x) + 0.5) * frame.scaleX;
  const globalY = frame.originY + (Math.floor(y) + 0.5) * frame.scaleY;
  const stream = displays.find((display) => contains(display, globalX, globalY));
  if (stream === undefined) return `(${x}, ${y}) is not on a shared display.`;
  return { stream, x: globalX - stream.x, y: globalY - stream.y };
};

const displaySummaries = (displays: ReadonlyArray<PortalStream>): Array<ComputerDisplay> =>
  displays.map((display, index) => ({
    index,
    x: Math.round(display.x),
    y: Math.round(display.y),
    width: Math.round(display.width),
    height: Math.round(display.height),
  }));

const invalid = (reason: string) => new ComputerUseInvalidActionError({ reason });

const busy = new ComputerUseUnavailableError({
  reason: "Another T3 thread is controlling this desktop. Wait for it to finish, or ask the user.",
});

const needsScreenshot = new ComputerUseUnavailableError({
  reason:
    "Call `computer_screenshot` first. It starts control of the desktop, and actions use its pixel coordinates.",
});

export class ComputerUse extends Context.Service<
  ComputerUse,
  {
    /** Starts control on the first call, which shows the desktop's consent dialog. */
    readonly screenshot: (input: {
      readonly threadId: ThreadId;
      readonly display?: number | undefined;
    }) => Effect.Effect<
      ComputerScreenshotResult,
      | ComputerUseUnavailableError
      | ComputerUseInvalidActionError
      | ComputerUseConsentError
      | ComputerUseOperationError
    >;
    readonly act: (
      input: ComputerActInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<
      void,
      | ComputerUseUnavailableError
      | ComputerUseInvalidActionError
      | ComputerUseConsentError
      | ComputerUseOperationError
    >;
    /** Ends this thread's control. `forget` also drops the saved grant. */
    readonly stop: (input: {
      readonly threadId: ThreadId;
      readonly forget: boolean;
    }) => Effect.Effect<{ readonly stopped: boolean }>;
  }
>()("t3/computer/ComputerUse") {}

const make = Effect.gen(function* () {
  const desktop = yield* KdeDesktop;
  const settings = yield* ServerSettings.ServerSettingsService;
  const hostname = yield* HostProcess.Hostname;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const idleTimer = yield* FiberHandle.make();
  const state = yield* Ref.make<ControlState>({
    active: null,
    opening: null,
    restoreToken: null,
    endedFor: null,
  });

  const closeActive = (options: { readonly forget: boolean }) =>
    Ref.modify(state, (current) => [
      current.active,
      {
        ...current,
        active: null,
        restoreToken: options.forget ? null : current.restoreToken,
      },
    ]).pipe(
      Effect.flatMap((active) =>
        active === null ? Effect.succeed(false) : active.session.close.pipe(Effect.as(true)),
      ),
    );

  const closeIfActive = (session: RemoteDesktopSession) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) =>
        current.active?.session === session ? closeActive({ forget: false }) : Effect.void,
      ),
      Effect.asVoid,
    );

  /** Closes a consent dialog still waiting for the user, and waits until it is gone. */
  const cancelOpening = (owner: ThreadId | null) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) =>
        current.opening !== null && (owner === null || current.opening.owner === owner)
          ? Fiber.interrupt(current.opening.fiber).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
    );

  // The user ended control from the desktop, which also revokes the saved grant.
  const watchClosed = (session: RemoteDesktopSession) =>
    session.closed.pipe(
      Effect.andThen(
        lock.withPermit(
          Ref.update(state, (current) =>
            current.active?.session === session
              ? { ...current, active: null, restoreToken: null, endedFor: current.active.owner }
              : current,
          ),
        ),
      ),
      Effect.andThen(session.close),
    );

  const touch = (session: RemoteDesktopSession) =>
    FiberHandle.run(idleTimer)(
      Effect.sleep(IDLE_TIMEOUT).pipe(Effect.andThen(lock.withPermit(closeIfActive(session)))),
    ).pipe(Effect.asVoid);

  const requireEnabled = settings.getSettings.pipe(
    Effect.mapError((cause) => new ComputerUseOperationError({ operation: "session", cause })),
    Effect.flatMap((value) =>
      value.enableAgentComputerAccess
        ? Effect.void
        : Effect.fail(
            new ComputerUseUnavailableError({
              reason:
                "Agent computer control is off for this environment. The user can turn it on in Settings > Devices.",
            }),
          ),
    ),
  );

  // Checked before waiting on the lock, so another thread never queues behind a consent dialog.
  const requireNotBusy = (threadId: ThreadId) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) => {
        const owner = current.active?.owner ?? current.opening?.owner ?? null;
        return owner === null || owner === threadId ? Effect.void : Effect.fail(busy);
      }),
    );

  const takeEnded = (threadId: ThreadId) =>
    Ref.modify(state, (current) =>
      current.endedFor === threadId ? [true, { ...current, endedFor: null }] : [false, current],
    ).pipe(
      Effect.flatMap((ended) =>
        ended ? Effect.fail(new ComputerUseConsentError({ outcome: "ended" })) : Effect.void,
      ),
    );

  const ensureControl = Effect.fn("ComputerUse.ensureControl")(function* (threadId: ThreadId) {
    yield* takeEnded(threadId);
    const current = yield* Ref.get(state);
    if (current.active !== null) {
      return current.active.owner === threadId ? current.active : yield* busy;
    }
    const reason = yield* desktop.unavailableReason;
    if (reason !== null) return yield* new ComputerUseUnavailableError({ reason });
    // A fiber of its own, so turning the setting off or `stop` can close the dialog.
    const fiber = yield* Effect.forkChild(desktop.openSession(current.restoreToken));
    yield* Ref.update(state, (value) => ({
      ...value,
      opening: { owner: threadId, fiber },
      endedFor: null,
    }));
    const exit = yield* Fiber.await(fiber).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(fiber)),
      Effect.ensuring(Ref.update(state, (value) => ({ ...value, opening: null }))),
    );
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) {
        yield* requireEnabled;
        return yield* new ComputerUseUnavailableError({
          reason: "Desktop control was stopped before the user answered the prompt.",
        });
      }
      yield* Ref.update(state, (value) => ({ ...value, restoreToken: null }));
      return yield* Effect.failCause(exit.cause);
    }
    const session = exit.value;
    const active: ActiveControl = {
      owner: threadId,
      session,
      displays: [...session.streams].sort((a, b) => a.x - b.x || a.y - b.y),
      frame: null,
    };
    yield* Ref.update(state, (value) => ({
      ...value,
      active,
      restoreToken: session.restoreToken,
    }));
    yield* Effect.forkIn(watchClosed(session), scope);
    return active;
  });

  const requireControl = (threadId: ThreadId) =>
    takeEnded(threadId).pipe(
      Effect.andThen(Ref.get(state)),
      Effect.flatMap((current) =>
        current.active?.owner === threadId && current.active.frame !== null
          ? Effect.succeed({ ...current.active, frame: current.active.frame })
          : Effect.fail(needsScreenshot),
      ),
    );

  const screenshot: ComputerUse["Service"]["screenshot"] = Effect.fn("ComputerUse.screenshot")(
    function* (input) {
      yield* requireNotBusy(input.threadId);
      return yield* lock.withPermit(
        Effect.gen(function* () {
          // Under the lock, so a call queued behind a consent dialog sees the setting turned off.
          yield* requireEnabled;
          const active = yield* ensureControl(input.threadId);
          yield* touch(active.session);
          // The user may have turned the setting off while the dialog was answered.
          yield* requireEnabled;
          if (input.display !== undefined && input.display >= active.displays.length) {
            return yield* invalid(
              `There is no display ${input.display}. Displays are 0 to ${active.displays.length - 1}.`,
            );
          }
          // A failed capture ends control, so a broken first screenshot never strands the desktop.
          const shot = yield* desktop.capture.pipe(
            Effect.flatMap((capture) =>
              Effect.try({
                try: () => renderScreenshot(capture, active.displays, input.display),
                catch: (cause) => new ComputerUseOperationError({ operation: "screenshot", cause }),
              }),
            ),
            Effect.filterOrFail(
              (shot): shot is Exclude<typeof shot, string> => typeof shot !== "string",
              () => new ComputerUseUnavailableError({ reason: layoutChanged }),
            ),
            Effect.tapError(() => closeIfActive(active.session)),
          );
          yield* Ref.update(state, (value) =>
            value.active?.session === active.session
              ? { ...value, active: { ...value.active, frame: shot.frame } }
              : value,
          );
          return {
            desktop: `KDE Plasma on ${hostname}`,
            displays: displaySummaries(active.displays),
            display: input.display ?? null,
            screenshot: {
              mimeType: "image/png" as const,
              data: Buffer.from(shot.png).toString("base64"),
              width: shot.frame.width,
              height: shot.frame.height,
            },
          };
        }),
      );
    },
  );

  const act: ComputerUse["Service"]["act"] = Effect.fn("ComputerUse.act")(function* (input) {
    yield* requireNotBusy(input.threadId);
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* requireEnabled;
        const active = yield* requireControl(input.threadId);
        const plan = yield* planAction(input, active.frame, active.displays);
        // The portal may hold a key or button that failed to release. Ending the session makes
        // KDE drop its virtual input device once no other remote session shares it, and KWin
        // then releases whatever that device still holds.
        yield* runPlan(active.session, plan).pipe(
          Effect.tapError(() => closeIfActive(active.session)),
          Effect.mapError((cause) => new ComputerUseOperationError({ operation: "input", cause })),
        );
        yield* touch(active.session);
      }),
    );
  });

  const stop: ComputerUse["Service"]["stop"] = Effect.fn("ComputerUse.stop")(function* (input) {
    // A pending screenshot holds the lock until its dialog is gone, so never wait behind one.
    if (yield* cancelOpening(input.threadId)) {
      if (input.forget) yield* Ref.update(state, (value) => ({ ...value, restoreToken: null }));
      return { stopped: true };
    }
    const owner = yield* Ref.get(state).pipe(
      Effect.map((current) => current.opening?.owner ?? current.active?.owner ?? null),
    );
    if (owner !== null && owner !== input.threadId) return { stopped: false };
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.active !== null && current.active.owner !== input.threadId) {
          return { stopped: false };
        }
        const stopped = yield* closeActive({ forget: input.forget });
        return { stopped };
      }),
    );
  });

  // Turning the setting off ends control now and forgets the grant.
  const changes = yield* settings.subscribeChanges;
  yield* changes.pipe(
    Stream.filter((value) => !value.enableAgentComputerAccess),
    Stream.runForEach(() =>
      cancelOpening(null).pipe(Effect.andThen(lock.withPermit(closeActive({ forget: true })))),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() => closeActive({ forget: true }));

  return ComputerUse.of({ screenshot, act, stop });
});

export const layer = Layer.effect(ComputerUse, make);

interface MoveStep {
  readonly _tag: "move";
  readonly stream: PortalStream;
  readonly x: number;
  readonly y: number;
}

type InputStep =
  | MoveStep
  | { readonly _tag: "button"; readonly button: number; readonly clicks: number }
  | { readonly _tag: "drag"; readonly path: ReadonlyArray<MoveStep> }
  | { readonly _tag: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly _tag: "keysyms"; readonly keysyms: ReadonlyArray<number> }
  | { readonly _tag: "combo"; readonly modifiers: ReadonlyArray<number>; readonly key: number };

/** Validates everything before any input reaches the desktop. */
const planAction = Effect.fn("ComputerUse.planAction")(function* (
  input: ComputerActInput,
  frame: ScreenshotFrame,
  displays: ReadonlyArray<PortalStream>,
): Effect.fn.Return<ReadonlyArray<InputStep>, ComputerUseInvalidActionError> {
  const point = (x: number | undefined, y: number | undefined, label: string) => {
    if (x === undefined || y === undefined) {
      return Effect.fail(invalid(`\`${input.action}\` needs ${label} from the latest screenshot.`));
    }
    const located = locatePoint(frame, displays, x, y);
    return typeof located === "string"
      ? Effect.fail(invalid(located))
      : Effect.succeed<MoveStep>({ _tag: "move", ...located });
  };
  switch (input.action) {
    case "move":
      return [yield* point(input.x, input.y, "`x` and `y`")];
    case "click":
    case "double_click":
    case "right_click":
    case "middle_click": {
      const button =
        input.action === "right_click"
          ? BUTTONS.right
          : input.action === "middle_click"
            ? BUTTONS.middle
            : BUTTONS.left;
      return [
        yield* point(input.x, input.y, "`x` and `y`"),
        { _tag: "button", button, clicks: input.action === "double_click" ? 2 : 1 },
      ];
    }
    case "drag": {
      const from = yield* point(input.x, input.y, "`x` and `y`");
      const to = yield* point(input.toX, input.toY, "`toX` and `toY`");
      // Apps start a drag only after the pointer moves while held, so pass through the middle.
      const middle =
        from.stream === to.stream
          ? [{ ...from, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }]
          : [];
      return [from, { _tag: "drag", path: [...middle, to] }];
    }
    case "scroll": {
      const notchesX = input.scrollX ?? 0;
      const notchesY = input.scrollY ?? 0;
      if (notchesX === 0 && notchesY === 0) {
        return yield* invalid("`scroll` needs `scrollX` or `scrollY` notches.");
      }
      const moves =
        input.x === undefined && input.y === undefined
          ? []
          : [yield* point(input.x, input.y, "both `x` and `y`")];
      return [
        ...moves,
        {
          _tag: "scroll",
          dx: notchesX * SCROLL_STEP,
          dy: notchesY * SCROLL_STEP * SCROLL_DOWN_SIGN,
        },
      ];
    }
    case "type": {
      if (!input.text) return yield* invalid("`type` needs `text`.");
      const keysyms = textKeysyms(input.text);
      if (keysyms === null) {
        return yield* invalid(
          "`text` has a control character. Use `key` for keys such as Escape; newline and tab are fine.",
        );
      }
      return [{ _tag: "keysyms", keysyms }];
    }
    case "key": {
      const combo = input.keys === undefined ? null : parseKeyCombo(input.keys);
      if (combo === null) {
        return yield* invalid(
          `\`key\` needs \`keys\` such as Return, Escape, Tab, BackSpace, Delete, Home, End, PageUp, PageDown, Up, Down, Left, Right, F1 to F24, space, or one character, after modifiers like ctrl+, shift+, alt+, super+.`,
        );
      }
      return [{ _tag: "combo", ...combo }];
    }
  }
});

/** Holds `press` for `use`; releases on success, and best effort on failure or interrupt. */
const held = <E>(
  press: Effect.Effect<void, E>,
  release: Effect.Effect<void, E>,
  use: Effect.Effect<void, E>,
) =>
  Effect.acquireUseRelease(
    press,
    () => use,
    (_, exit) => (Exit.isSuccess(exit) ? release : Effect.ignore(release)),
  );

const runPlan = (session: RemoteDesktopSession, plan: ReadonlyArray<InputStep>) => {
  type Step = Effect.Effect<void, PortalCallError>;
  const move = (step: MoveStep) => session.pointerMotionAbsolute(step.stream, step.x, step.y);
  const button = (code: number, use: Step) =>
    held(session.pointerButton(code, true), session.pointerButton(code, false), use);
  const key = (keysym: number, use: Step = Effect.void) =>
    held(session.keyboardKeysym(keysym, true), session.keyboardKeysym(keysym, false), use);
  return Effect.forEach(
    plan,
    (step): Step => {
      switch (step._tag) {
        case "move":
          return move(step);
        case "button":
          return Effect.forEach(
            Array.from({ length: step.clicks }),
            () => button(step.button, Effect.void),
            { discard: true },
          );
        case "drag":
          return button(BUTTONS.left, Effect.forEach(step.path, move, { discard: true }));
        case "scroll":
          return session.pointerAxis(step.dx, step.dy);
        case "keysyms":
          return Effect.forEach(step.keysyms, (keysym) => key(keysym), { discard: true });
        case "combo":
          return step.modifiers.reduceRight<Step>(
            (inner, modifier) => key(modifier, inner),
            key(step.key),
          );
      }
    },
    { discard: true },
  );
};
