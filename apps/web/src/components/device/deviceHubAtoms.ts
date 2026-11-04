import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  appendDeviceEventLog,
  type DeviceAxElement,
  type DeviceEventLogEntry,
  type DeviceForegroundInfo,
  type DeviceHubTarget,
  fetchDeviceAxTree,
  subscribeDeviceEventLog,
  subscribeDeviceForeground,
} from "./deviceHubApi";
import { AndroidFoldError, readAndroidFold, type AndroidFoldState } from "./deviceFold";

const AX_POLL_INTERVAL_MS = 2_000;
const FOLD_RETRY_MS = 3_000;

/** `undefined` until the hub reports an app; the device detail's app fills in until then. */
export const deviceForegroundAtom = Atom.family((target: DeviceHubTarget) =>
  Atom.make<DeviceForegroundInfo | null | undefined>((get) => {
    get.addFinalizer(subscribeDeviceForeground(target, (app) => get.setSelf(app)));
    return undefined;
  }).pipe(Atom.withLabel(`device-foreground:${target.deviceId}`)),
);

export const deviceEventLogAtom = Atom.family((target: DeviceHubTarget) =>
  Atom.make<ReadonlyArray<DeviceEventLogEntry>>((get) => {
    let entries: ReadonlyArray<DeviceEventLogEntry> = [];
    get.addFinalizer(
      subscribeDeviceEventLog(target, (incoming, reset) => {
        entries = appendDeviceEventLog(entries, incoming, reset);
        get.setSelf(entries);
      }),
    );
    return entries;
  }).pipe(Atom.withLabel(`device-event-log:${target.deviceId}`)),
);

// A failed poll keeps the last frames on screen; the next poll replaces them.
export const deviceAxElementsAtom = Atom.family((target: DeviceHubTarget) =>
  Atom.make(
    Stream.fromEffectSchedule(
      Effect.tryPromise((signal) => fetchDeviceAxTree(target, signal)).pipe(
        Effect.map((tree): ReadonlyArray<DeviceAxElement> | null => tree.elements),
        Effect.orElseSucceed(() => null),
      ),
      Schedule.spaced(AX_POLL_INTERVAL_MS),
    ).pipe(Stream.filter((elements) => elements !== null)),
  ).pipe(Atom.withLabel(`device-ax-elements:${target.deviceId}`)),
);

export interface AndroidFoldView {
  readonly fold: AndroidFoldState | null;
  /** Hinge angle the 3D phone shows, including an optimistic one while a change is in flight. */
  readonly angle: number | null;
}

export const foldAngle = (fold: AndroidFoldState) =>
  fold.hingeAngle ?? (fold.posture === "closed" ? 0 : 180);

/**
 * The fold controls and the 3D phone share one view of a device's fold. Keyed by
 * host and device, not by hub access, so a renewed ticket keeps the known posture.
 */
export const androidFoldViewAtom = Atom.family((deviceKey: string) =>
  Atom.make<AndroidFoldView>({ fold: null, angle: null }).pipe(
    Atom.withLabel(`android-fold-view:${deviceKey}`),
  ),
);

/**
 * Reads the fold while mounted and records it in the device's fold view. The
 * screen size is part of the key because folding resizes the screen, so a new
 * size means the posture may have changed. An expired ticket stops retrying:
 * renewed access is a new key and reads again.
 */
export const androidFoldReadAtom = Atom.family(
  (input: {
    readonly deviceKey: string;
    readonly access: DeviceHubAccess;
    readonly deviceId: string;
    readonly screenWidth: number;
    readonly screenHeight: number;
  }) =>
    Atom.make((get) =>
      Effect.tryPromise({
        try: (signal) => readAndroidFold(input.access, input.deviceId, signal),
        catch: (cause) => ({ expired: cause instanceof AndroidFoldError && cause.status === 401 }),
      }).pipe(
        Effect.retry({
          while: (failure) => !failure.expired,
          schedule: Schedule.spaced(FOLD_RETRY_MS),
        }),
        Effect.tap((fold) =>
          Effect.sync(() =>
            get.set(androidFoldViewAtom(input.deviceKey), {
              fold,
              angle: fold.supported ? foldAngle(fold) : null,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    ).pipe(Atom.withLabel(`android-fold-read:${input.deviceKey}`)),
);

export const NOOP_ATOM = Atom.make(AsyncResult.initial<void, never>()).pipe(
  Atom.withLabel("device:noop"),
);

export const NO_FOREGROUND_ATOM = Atom.make<DeviceForegroundInfo | null | undefined>(
  undefined,
).pipe(Atom.withLabel("device-foreground:none"));
