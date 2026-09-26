import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Desktop IPC channels backing Keep Awake.
 * Wired in the desktop shell (apps/desktop/src/ipc/channels.ts + preload.ts):
 * preload exposes `getKeepAwakeState` / `setKeepAwakeEnabled` on
 * `window.desktopBridge`, each implemented as
 * `ipcRenderer.invoke(<channel below>)`.
 */
export const GET_KEEP_AWAKE_STATE_CHANNEL = "desktop:get-keep-awake-state";
export const SET_KEEP_AWAKE_ENABLED_CHANNEL = "desktop:set-keep-awake-enabled";

const KEEP_AWAKE_STATE_STALE_TIME_MS = 30_000;

export const KeepAwakeStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
});

export interface KeepAwakeState {
  readonly enabled: boolean;
  /** False on machines where the OS inhibitors are unavailable. */
  readonly supported: boolean;
}

/**
 * Minimal bridge surface for Keep Awake. Declared structurally instead of
 * `Pick<DesktopBridge, ...>` so web also builds against older desktop shells
 * where these methods are absent — callers treat missing methods as
 * unsupported (disabled row with tooltip) rather than crashing.
 */
export interface KeepAwakeBridge {
  readonly getKeepAwakeState?: () => Promise<KeepAwakeState>;
  readonly setKeepAwakeEnabled?: (enabled: boolean) => Promise<KeepAwakeState>;
}

class KeepAwakeStateUnavailableError extends Schema.TaggedError<KeepAwakeStateUnavailableError>()(
  "KeepAwakeStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Keep Awake is unavailable.";
  }
}

class KeepAwakeStateLoadError extends Schema.TaggedError<KeepAwakeStateLoadError>()(
  "KeepAwakeStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load Keep Awake state.";
  }
}

export class KeepAwakeUnsupportedError extends Error {
  override readonly name = "KeepAwakeUnsupportedError";
  constructor() {
    super("This version of the desktop app does not support Keep Awake.");
  }
}

function getKeepAwakeBridge(): KeepAwakeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createKeepAwakeStateAtom(getBridge: () => KeepAwakeBridge | undefined) {
  const loadKeepAwakeState = Effect.fn("loadKeepAwakeState")(function* () {
    const bridge = getBridge();
    if (!bridge?.getKeepAwakeState) {
      return yield* new KeepAwakeStateUnavailableError();
    }
    const getState = bridge.getKeepAwakeState;
    return yield* Effect.tryPromise({
      try: (): Promise<KeepAwakeState> => getState(),
      catch: (cause) => new KeepAwakeStateLoadError({ cause }),
    });
  });

  return Atom.make(loadKeepAwakeState()).pipe(
    Atom.swr({
      staleTime: KEEP_AWAKE_STATE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:keep-awake-state:load"),
  );
}

export const keepAwakeStateAtom = createKeepAwakeStateAtom(getKeepAwakeBridge);

export function refreshKeepAwakeState(): void {
  appAtomRegistry.refresh(keepAwakeStateAtom);
}

/**
 * Toggle entry point for the settings row. Resolves via the
 * `desktop:set-keep-awake-enabled` channel (see preload's
 * `setKeepAwakeEnabled`); throws {@link KeepAwakeUnsupportedError} on older
 * desktop shells that lack the method.
 */
export async function setKeepAwakeEnabled(enabled: boolean): Promise<KeepAwakeState> {
  const bridge = getKeepAwakeBridge();
  if (!bridge?.setKeepAwakeEnabled) {
    throw new KeepAwakeUnsupportedError();
  }
  return bridge.setKeepAwakeEnabled(enabled);
}
