import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import type { DuoControlState } from "@t3tools/client-runtime/device/duo-control";
import {
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "@t3tools/client-runtime/device/stream";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DevicePlatform, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { refreshDeviceHubAccess } from "~/state/device";

export interface DeviceStreamState {
  readonly status: DeviceStreamStatus;
  readonly detail: string | undefined;
  /** A frame arrived during this session, so a reconnect can keep showing it. */
  readonly hasFrame: boolean;
  readonly screen: DeviceScreenSize | null;
  readonly mjpegUrl: string | null;
  readonly mjpegGeneration: number;
  readonly input: { readonly connected: boolean; readonly detail?: string };
  readonly duoControl: DuoControlState;
  readonly phoneUnavailable: boolean;
}

export interface DeviceStreamSession {
  readonly stream: DeviceStreamClient;
  /** The stream draws here; the view mounts it and the 3D viewers sample it. */
  readonly canvas: HTMLCanvasElement;
  readonly setFrameListener: (listener: (() => void) | null) => void;
  /** Called when the hub rejects a Duo control, so the 3D viewer drops its optimistic pose. */
  readonly setControlRejectedListener: (listener: (() => void) | null) => void;
  readonly markPhoneUnavailable: () => void;
  readonly reconnect: () => void;
  readonly state: DeviceStreamState;
}

export interface DeviceStreamKey {
  readonly environmentId: EnvironmentId;
  readonly hostId: string;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  /** See `DeviceStreamTarget.serveSimOnly`. */
  readonly serveSimOnly: boolean;
  /** Each mounted view owns its own client: one canvas cannot be in two places. */
  readonly viewId: string;
}

export const IDLE_DEVICE_STREAM_STATE: DeviceStreamState = {
  status: "connecting",
  detail: undefined,
  hasFrame: false,
  screen: null,
  mjpegUrl: null,
  mjpegGeneration: 0,
  input: { connected: false },
  duoControl: { pending: false, requested: null, error: null },
  phoneUnavailable: false,
};

export const deviceScreenKey = (environmentId: EnvironmentId, hostId: string, deviceId: string) =>
  `${environmentId}\u0000${hostId}\u0000${deviceId}`;

/**
 * The screen one view's stream last reported, null while that view streams nothing.
 * Keyed by view, not device: two views of one device stream independently, and one
 * ending must not clear the other's size. The mini player lays out its frame from it.
 */
export const deviceStreamScreenAtom = Atom.family((viewId: string) =>
  Atom.make<DeviceScreenSize | null>(null).pipe(Atom.withLabel(`device-stream-screen:${viewId}`)),
);

/** A device's video and input connection, live while a view reads it. */
export const deviceStreamSessionAtom = Atom.family((key: DeviceStreamKey) =>
  Atom.make((get): DeviceStreamSession => {
    const screenAtom = deviceStreamScreenAtom(key.viewId);
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    let frameListener: (() => void) | null = null;
    let controlRejectedListener: (() => void) | null = null;
    let state = IDLE_DEVICE_STREAM_STATE;
    let session: DeviceStreamSession;
    const update = (patch: Partial<DeviceStreamState>) => {
      state = { ...state, ...patch };
      session = { ...session, state };
      get.setSelf(session);
    };
    const client = createDeviceStreamClient(
      {
        platform: key.platform,
        deviceId: key.deviceId,
        access: key.access,
        serveSimOnly: key.serveSimOnly,
      },
      createCanvasFrameSink(canvas, () => frameListener?.()),
      {
        onDuoControl: (duoControl) => {
          if (duoControl.error && duoControl.error !== state.duoControl.error)
            controlRejectedListener?.();
          update({ duoControl });
        },
        onDuoUnavailable: () => update({ phoneUnavailable: true }),
        onStatus: (status, detail) =>
          update({ status, detail, ...(status === "streaming" ? { hasFrame: true } : {}) }),
        onScreen: (screen) => {
          get.set(screenAtom, screen);
          update({ screen });
        },
        onUnauthorized: () => refreshDeviceHubAccess(key.environmentId),
        onMjpegFallback: (mjpegUrl) =>
          update({ mjpegUrl, mjpegGeneration: state.mjpegGeneration + 1 }),
        onCanvasVideo: () => update({ mjpegUrl: null }),
        onInputConnected: (connected, detail) =>
          update({ input: { connected, ...(detail ? { detail } : {}) } }),
      },
    );
    session = {
      stream: client,
      canvas,
      setFrameListener: (listener) => {
        frameListener = listener;
      },
      setControlRejectedListener: (listener) => {
        controlRejectedListener = listener;
      },
      markPhoneUnavailable: () => update({ phoneUnavailable: true }),
      reconnect: () => {
        client.stop();
        update({ phoneUnavailable: false });
        client.start();
      },
      state,
    };
    get.addFinalizer(() => {
      client.stop();
      get.registry.set(screenAtom, null);
    });
    client.start();
    return session;
  }).pipe(Atom.withLabel(`device-stream:${key.platform}:${key.deviceId}`)),
);
