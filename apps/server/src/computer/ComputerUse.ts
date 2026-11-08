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
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

/** A shared stream, cut to the screen it matched in a capture. */
interface SharedArea {
  readonly stream: PortalStream;
  /** The only logical area this stream's pixels and input may cover. */
  readonly rect: DesktopRect;
}

/** How pixels in the last screenshot map to the desktop's logical coordinates. */
export interface ScreenshotFrame {
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly width: number;
  readonly height: number;
  readonly shared: ReadonlyArray<SharedArea>;
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
  readonly ticket: object;
  /** Null when cancelled. Interrupting it closes the consent dialog. */
  readonly fiber: Fiber.Fiber<ActiveControl | null, OpenSessionError>;
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

const intersect = (a: DesktopRect, b: DesktopRect): DesktopRect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

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
    Math.abs(image.height - bounds.height * capture.scale) > 2 * capture.scale
  ) {
    return layoutChanged;
  }
  // Rounding can leave a stream a pixel off its screen, so only their overlap counts as shared.
  const shared: Array<SharedArea> = [];
  for (const stream of displays) {
    const screen = capture.screens.find((candidate) => matches(stream, candidate));
    const rect = screen === undefined ? null : intersect(stream, screen);
    if (rect === null) return layoutChanged;
    shared.push({ stream, rect });
  }
  const pixelsX = image.width / bounds.width;
  const pixelsY = image.height / bounds.height;
  const area =
    display === undefined
      ? workspaceBounds(shared.map((entry) => entry.rect))
      : shared[display]!.rect;
  const left = Math.max(0, Math.min(image.width - 1, Math.round((area.x - bounds.x) * pixelsX)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round((area.y - bounds.y) * pixelsY)));
  const rect = {
    x: left,
    y: top,
    width: Math.max(1, Math.min(image.width - left, Math.round(area.width * pixelsX))),
    height: Math.max(1, Math.min(image.height - top, Math.round(area.height * pixelsY))),
  };
  // Black out unshared pixels before downscaling, so no output pixel averages any of them in.
  const visibleColumns = new Uint8Array(rect.width);
  for (let row = rect.y; row < rect.y + rect.height; row++) {
    const y = bounds.y + (row + 0.5) / pixelsY;
    visibleColumns.fill(0);
    for (const { rect: visible } of shared) {
      if (y < visible.y || y >= visible.y + visible.height) continue;
      // Pixels whose centres fall inside the area, as `contains` decides.
      const from = Math.ceil((visible.x - bounds.x) * pixelsX - 0.5) - rect.x;
      const to = Math.ceil((visible.x + visible.width - bounds.x) * pixelsX - 0.5) - rect.x;
      visibleColumns.fill(1, Math.max(0, from), Math.max(0, Math.min(rect.width, to)));
    }
    for (let column = 0; column < rect.width; column++) {
      if (visibleColumns[column] === 0) {
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
    shared,
  };
  return { png: encodePng(cropAndResize(image, rect, size.width, size.height)), frame };
};

/** A screenshot pixel as a position inside one stream, or why it has none. */
export const locatePoint = (
  frame: ScreenshotFrame,
  x: number,
  y: number,
): { readonly stream: PortalStream; readonly x: number; readonly y: number } | string => {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return `(${x}, ${y}) is outside the last screenshot, which is ${frame.width}x${frame.height}.`;
  }
  // Aim at the centre of the pixel, which matters once the screenshot is downscaled.
  const globalX = frame.originX + (Math.floor(x) + 0.5) * frame.scaleX;
  const globalY = frame.originY + (Math.floor(y) + 0.5) * frame.scaleY;
  const area = frame.shared.find((entry) => contains(entry.rect, globalX, globalY));
  if (area === undefined) return `(${x}, ${y}) is not on a shared display.`;
  return { stream: area.stream, x: globalX - area.stream.x, y: globalY - area.stream.y };
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

  // Revoking needs no lock: state changes are atomic, and running calls race `session.closed`.
  /**
   * When `which` accepts the state, ends any control and applies `forget` even if none is active.
   * Returns whether a session ended, once it is closed.
   */
  const closeActive = (forget: boolean, which: (current: ControlState) => boolean) =>
    Ref.modify(state, (current) =>
      which(current)
        ? [
            current.active,
            { ...current, active: null, restoreToken: forget ? null : current.restoreToken },
          ]
        : [null, current],
    ).pipe(
      Effect.flatMap((active) =>
        active === null ? Effect.succeed(false) : active.session.close.pipe(Effect.as(true)),
      ),
    );

  /** Only `session`'s control, so cleanup for an old session never touches a newer one's grant. */
  const closeSession = (session: RemoteDesktopSession, forget: boolean) =>
    closeActive(forget, (current) => current.active?.session === session);

  const closeIfActive = (session: RemoteDesktopSession) =>
    closeSession(session, false).pipe(Effect.asVoid);

  /**
   * Takes a dialog still waiting for the user out of state, so it can never start control, and
   * returns once its fiber has closed the dialog or the session the user just allowed.
   */
  const cancelOpening = (which: (opening: Opening) => boolean, forget: boolean) =>
    Ref.modify(state, (current) =>
      current.opening !== null && which(current.opening)
        ? [
            current.opening,
            { ...current, opening: null, restoreToken: forget ? null : current.restoreToken },
          ]
        : [null, current],
    ).pipe(
      Effect.flatMap((opening) =>
        opening === null
          ? Effect.succeed(false)
          : Fiber.interrupt(opening.fiber).pipe(Effect.as(true)),
      ),
    );

  // The user ended control from the desktop, which also revokes the saved grant.
  const endedByDesktop = (session: RemoteDesktopSession) =>
    Ref.update(state, (current) =>
      current.active?.session === session
        ? { ...current, active: null, restoreToken: null, endedFor: current.active.owner }
        : current,
    ).pipe(Effect.andThen(session.close));

  const watchClosed = (session: RemoteDesktopSession) =>
    session.closed.pipe(Effect.andThen(endedByDesktop(session)));

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

  /**
   * Checks the desktop, then opens a session and starts control with it, unless `cancelOpening`
   * took the ticket first. Runs uninterruptibly but for those steps, so the hand-off always settles.
   */
  const openControl = Effect.fn("ComputerUse.openControl")(function* (
    threadId: ThreadId,
    ticket: object,
  ) {
    let asked = false;
    const exit = yield* Effect.exit(
      Effect.interruptible(
        Effect.gen(function* () {
          const reason = yield* desktop.unavailableReason;
          if (reason !== null) return yield* new ComputerUseUnavailableError({ reason });
          // Checked again after the lookup above, so a setting turned off meanwhile shows no dialog.
          yield* requireEnabled;
          // Read only now, so a grant that `stop` forgot during the checks is never offered.
          const current = yield* Ref.get(state);
          if (current.opening?.ticket !== ticket) return yield* Effect.interrupt;
          asked = true;
          return yield* desktop.openSession(current.restoreToken);
        }),
      ),
    );
    const failed = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause);
    const active: ActiveControl | null = Exit.isSuccess(exit)
      ? {
          owner: threadId,
          session: exit.value,
          displays: [...exit.value.streams].sort((a, b) => a.x - b.x || a.y - b.y),
          frame: null,
        }
      : null;
    const claimed = yield* Ref.modify(state, (current) =>
      current.opening?.ticket === ticket
        ? [
            true,
            {
              ...current,
              opening: null,
              active: active ?? current.active,
              restoreToken:
                active !== null
                  ? active.session.restoreToken
                  : failed && asked
                    ? null
                    : current.restoreToken,
            },
          ]
        : [false, current],
    );
    if (!claimed) {
      // `cancelOpening` is waiting for this fiber, so the session closes before it returns.
      if (active !== null) yield* active.session.close;
      return null;
    }
    if (Exit.isFailure(exit) && failed) return yield* Effect.failCause(exit.cause);
    if (active !== null) {
      // Idles out from here, so control still ends if the waiting call is interrupted.
      yield* touch(active.session);
      yield* Effect.forkIn(watchClosed(active.session), scope);
    }
    return active;
  });

  const ensureControl = Effect.fn("ComputerUse.ensureControl")(function* (threadId: ThreadId) {
    yield* takeEnded(threadId);
    const current = yield* Ref.get(state);
    if (current.active !== null) {
      return current.active.owner === threadId ? current.active : yield* busy;
    }
    // A fiber of its own, in state before any check that waits, so turning the setting off or
    // `stop` can cancel the checks or close the dialog. It waits for its ticket to be in state,
    // and nothing interrupts the registration, so it finds it.
    const ticket = {};
    const registered = yield* Deferred.make<void>();
    const fiber = yield* Effect.uninterruptible(
      Effect.forkIn(
        Deferred.await(registered).pipe(Effect.andThen(openControl(threadId, ticket))),
        scope,
        { uninterruptible: true },
      ).pipe(
        Effect.tap((fiber) =>
          Ref.update(state, (value) => ({
            ...value,
            opening: { owner: threadId, ticket, fiber },
            endedFor: null,
          })),
        ),
        Effect.tap(Deferred.succeed(registered, undefined)),
      ),
    );
    const exit = yield* Fiber.await(fiber).pipe(
      // The agent stopped waiting, so close the dialog as `stop` would.
      Effect.onInterrupt(() => cancelOpening((opening) => opening.ticket === ticket, false)),
    );
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
    if (exit.value === null) {
      yield* requireEnabled;
      return yield* new ComputerUseUnavailableError({
        reason: "Desktop control was stopped before the user answered the prompt.",
      });
    }
    return exit.value;
  });

  /** A setting check that also ends `session`'s control, so a revoked grant never lingers. */
  const requireEnabledFor = (session: RemoteDesktopSession) =>
    requireEnabled.pipe(Effect.tapError(() => closeSession(session, true)));

  /** Why control ended under a running call, told the way the thread's next call would hear it. */
  const controlEnded = (active: ActiveControl) =>
    endedByDesktop(active.session).pipe(
      Effect.andThen(requireEnabled),
      Effect.andThen(takeEnded(active.owner)),
      Effect.andThen(
        Effect.fail(
          new ComputerUseUnavailableError({
            reason: "Desktop control ended before this call finished.",
          }),
        ),
      ),
    );

  /** Runs `effect` with `active`'s session, abandoning it and its result if control ends first. */
  const whileControlled = Effect.fn("ComputerUse.whileControlled")(function* <A, E>(
    active: ActiveControl,
    effect: Effect.Effect<A, E>,
  ) {
    const result = yield* Effect.raceFirst(
      Effect.asSome(effect),
      Effect.as(active.session.closed, Option.none<A>()),
    );
    if (Option.isNone(result)) return yield* controlEnded(active);
    yield* requireEnabledFor(active.session);
    // Last, with nothing that waits after it, so control that ended during the read above counts.
    const current = yield* Ref.get(state);
    if (current.active?.session !== active.session || (yield* active.session.isClosed)) {
      return yield* controlEnded(active);
    }
    return result.value;
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
          yield* requireEnabledFor(active.session);
          if (input.display !== undefined && input.display >= active.displays.length) {
            return yield* invalid(
              `There is no display ${input.display}. Displays are 0 to ${active.displays.length - 1}.`,
            );
          }
          // A failed capture ends control, so a broken first screenshot never strands the desktop.
          const shot = yield* whileControlled(
            active,
            desktop.capture.pipe(
              Effect.flatMap((capture) =>
                Effect.try({
                  try: () => renderScreenshot(capture, active.displays, input.display),
                  catch: (cause) =>
                    new ComputerUseOperationError({ operation: "screenshot", cause }),
                }),
              ),
              Effect.filterOrFail(
                (shot): shot is Exclude<typeof shot, string> => typeof shot !== "string",
                () => new ComputerUseUnavailableError({ reason: layoutChanged }),
              ),
              Effect.tapError(() => closeIfActive(active.session)),
            ),
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
        const plan = yield* planAction(input, active.frame);
        // The portal may hold a key or button that failed to release. Ending the session makes
        // KDE drop its virtual input device once no other remote session shares it, and KWin
        // then releases whatever that device still holds.
        yield* whileControlled(
          active,
          runPlan(active.session, plan).pipe(
            // Interrupted too, since a release cut short or failed may have left input held.
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : closeIfActive(active.session),
            ),
            Effect.mapError(
              (cause) => new ComputerUseOperationError({ operation: "input", cause }),
            ),
          ),
        );
        yield* touch(active.session);
      }),
    );
  });

  // Never takes the lock, which a dialog or capture can hold for a long time.
  const stop: ComputerUse["Service"]["stop"] = Effect.fn("ComputerUse.stop")(function* (input) {
    if (yield* cancelOpening((opening) => opening.owner === input.threadId, input.forget)) {
      return { stopped: true };
    }
    const stopped = yield* closeActive(input.forget, (current) => {
      const owner = current.active?.owner ?? current.opening?.owner;
      return owner === undefined || owner === input.threadId;
    });
    return { stopped };
  });

  // Turning the setting off ends control now and forgets the grant.
  const changes = yield* settings.subscribeChanges;
  yield* changes.pipe(
    Stream.filter((value) => !value.enableAgentComputerAccess),
    Stream.runForEach(() =>
      cancelOpening(() => true, true).pipe(Effect.andThen(closeActive(true, () => true))),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() => closeActive(true, () => true));

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
): Effect.fn.Return<ReadonlyArray<InputStep>, ComputerUseInvalidActionError> {
  const point = (x: number | undefined, y: number | undefined, label: string) => {
    if (x === undefined || y === undefined) {
      return Effect.fail(invalid(`\`${input.action}\` needs ${label} from the latest screenshot.`));
    }
    const located = locatePoint(frame, x, y);
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
