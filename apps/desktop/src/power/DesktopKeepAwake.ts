// @effect-diagnostics nodeBuiltinImport:off -- This Windows platform boundary drives powercfg via spawnSync (windowsHide) and reads/writes the userData crash-recovery file with Node.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

/**
 * DesktopKeepAwake — Brutal Awake behavior for the Electron main process.
 *
 * While enabled this keeps the computer awake with the display on, even with
 * the lid closed, via three overlapping mechanisms on Windows (mirroring
 * `brutal awake/src-tauri/src/main.rs`):
 *
 * 1. `powerSaveBlocker.start("prevent-display-sleep")` — display + system
 *    inhibition for our process.
 * 2. `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
 *    ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED)` called via `ffi-rs` from
 *    our own process (execution-state requests are process-scoped, so they
 *    MUST be made from the Electron main process, never a short-lived
 *    child). Follows the exact `ffi-rs` convention of
 *    `electron/WindowsForeground.ts` (`open` + `load` on `kernel32.dll`).
 * 3. `powercfg` forces lid-close action to `0` (Do Nothing) and Sleep-after /
 *    Hibernate-after to `0` (never) on `SCHEME_CURRENT`, with a single
 *    batched `/setactive` — this is what actually keeps Modern Standby (S0)
 *    laptops awake, where the system-required flag alone is ignored.
 *
 * macOS/Linux hold `powerSaveBlocker("prevent-display-sleep")` only; there
 * is no `powercfg` equivalent there.
 *
 * Safety net around the global side effects:
 *
 * - The six overridden values (lid AC/DC, sleep-after AC/DC,
 *   hibernate-after AC/DC) are queried and saved ONLY on the off→on
 *   transition (guarded by a `Ref`, so re-enable never clobbers the
 *   originals with our own forced values), then restored on disable.
 * - The saved values are also persisted to a JSON recovery file under
 *   Electron `userData` (`app.getPath("userData")`, best-effort — skipped
 *   when unavailable), deleted on clean disable/restore. If a previous
 *   session crashed or was killed while enabled, service init finds the file,
 *   best-effort restores those values + `/setactive`, deletes it, and logs.
 * - A `forkScoped` 25 s re-assert loop re-applies the forced values and the
 *   execution state while still enabled (checks the `Ref`; dies with the
 *   layer scope).
 * - The layer-scope-close finalizer runs the same restore path when still
 *   enabled and can never throw.
 */
export const DesktopKeepAwakeBlockerTypeSchema = Schema.Literal("prevent-display-sleep");
export type DesktopKeepAwakeBlockerType = typeof DesktopKeepAwakeBlockerTypeSchema.Type;

/** The only blocker type this service may ever use. */
export const KEEP_AWAKE_BLOCKER_TYPE: DesktopKeepAwakeBlockerType = "prevent-display-sleep";

export const DesktopKeepAwakeStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
  blockerType: DesktopKeepAwakeBlockerTypeSchema,
});
export type DesktopKeepAwakeState = typeof DesktopKeepAwakeStateSchema.Type;

export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    readonly getState: Effect.Effect<DesktopKeepAwakeState, never, never>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<DesktopKeepAwakeState, never, never>;
  }
>()("@t3tools/desktop/power/DesktopKeepAwake") {}

// --- SetThreadExecutionState flags (kernel32) -------------------------------

const ES_CONTINUOUS = 0x8000_0000;
const ES_SYSTEM_REQUIRED = 0x0000_0001;
const ES_DISPLAY_REQUIRED = 0x0000_0002;
const ES_AWAYMODE_REQUIRED = 0x0000_0040;
const ES_AWAKE_FLAGS =
  ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED;

// --- powercfg setting GUIDs (stable across Windows installs) ----------------

const SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";
const LIDACTION = "5ca83367-6e45-459f-a27b-476b1d01c936";
const SUB_SLEEP = "238c9fa8-0aad-41ed-83f4-97be242c8f20";
const STANDBYIDLE = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"; // "Sleep after"
const HIBERNATEIDLE = "9d7815a6-7ee4-497e-8888-515a05f02364"; // "Hibernate after"

/** Original values of every power setting we override, so we can put them back. */
export interface KeepAwakeSavedSettings {
  readonly lidAc?: number | undefined;
  readonly lidDc?: number | undefined;
  readonly sleepAc?: number | undefined;
  readonly sleepDc?: number | undefined;
  readonly hibAc?: number | undefined;
  readonly hibDc?: number | undefined;
}

/** Name of the JSON crash-recovery file inside Electron `userData`. */
export const KEEP_AWAKE_RECOVERY_FILE_NAME = "keep-awake-recovery.json";

const KEEP_AWAKE_REASSERT_INTERVAL = Duration.seconds(25);

// --- Execution state via ffi-rs (own process only) --------------------------

interface ExecutionStateApi {
  readonly setThreadExecutionState: (flags: number) => number;
}

let executionStateApiPromise: Promise<ExecutionStateApi> | undefined;

const loadExecutionStateApi = (): Promise<ExecutionStateApi> => {
  executionStateApiPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "t3-keep-awake-kernel32";
    open({ library, path: "kernel32.dll" });
    return {
      setThreadExecutionState: (flags: number) =>
        load({
          library,
          funcName: "SetThreadExecutionState",
          retType: DataType.U32,
          paramsType: [DataType.U32],
          paramsValue: [flags],
        }) as number,
    } satisfies ExecutionStateApi;
  });
  return executionStateApiPromise;
};

const defaultApplyExecutionState = (on: boolean): Effect.Effect<void, never, never> => {
  if (process.platform !== "win32") {
    return Effect.void;
  }
  return Effect.ignore(
    Effect.promise(() =>
      loadExecutionStateApi().then((api) => {
        api.setThreadExecutionState(on ? ES_AWAKE_FLAGS : ES_CONTINUOUS);
      }),
    ),
  );
};

// --- powercfg helpers (mirroring Brutal Awake's force_awake/restore_all) ----

const defaultRunPowercfg = (args: ReadonlyArray<string>): string => {
  try {
    const result = NodeChildProcess.spawnSync("powercfg", [...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      return "";
    }
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
};

const parseFirstHex = (out: string): number | undefined => {
  for (const token of out.split(/\s+/)) {
    if (token.startsWith("0x")) {
      const hex = token.slice(2).trim();
      if (hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex)) {
        return Number.parseInt(hex, 16);
      }
    }
  }
  return undefined;
};

// Read the current AC and DC index for one power setting.
const querySetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  sub: string,
  setting: string,
): readonly [number | undefined, number | undefined] => {
  const acOut = runPowercfg(["/getacvalueindex", "SCHEME_CURRENT", sub, setting]);
  const dcOut = runPowercfg(["/getdcvalueindex", "SCHEME_CURRENT", sub, setting]);
  return [parseFirstHex(acOut), parseFirstHex(dcOut)];
};

// Set one power setting's AC and DC index (no /setactive — caller batches it).
const setSetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  sub: string,
  setting: string,
  value: number,
): void => {
  const v = value.toString();
  runPowercfg(["/setacvalueindex", "SCHEME_CURRENT", sub, setting, v]);
  runPowercfg(["/setdcvalueindex", "SCHEME_CURRENT", sub, setting, v]);
};

// Restore one setting's AC/DC index if we recorded originals for it.
const restoreSetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  sub: string,
  setting: string,
  ac: number | undefined,
  dc: number | undefined,
): void => {
  if (ac !== undefined) {
    runPowercfg(["/setacvalueindex", "SCHEME_CURRENT", sub, setting, ac.toString()]);
  }
  if (dc !== undefined) {
    runPowercfg(["/setdcvalueindex", "SCHEME_CURRENT", sub, setting, dc.toString()]);
  }
};

// Force lid=Do Nothing and sleep/hibernate timeouts to 0 (never), batched
// with a single /setactive like Brutal Awake.
const forcePowerSettings = (runPowercfg: (args: ReadonlyArray<string>) => string): void => {
  setSetting(runPowercfg, SUB_BUTTONS, LIDACTION, 0); // 0 = Do nothing on lid close
  setSetting(runPowercfg, SUB_SLEEP, STANDBYIDLE, 0); // 0 = never sleep
  setSetting(runPowercfg, SUB_SLEEP, HIBERNATEIDLE, 0); // 0 = never hibernate
  runPowercfg(["/setactive", "SCHEME_CURRENT"]);
};

// Put every overridden power setting back to what the user had.
const restorePowerSettings = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  saved: KeepAwakeSavedSettings,
): void => {
  restoreSetting(runPowercfg, SUB_BUTTONS, LIDACTION, saved.lidAc, saved.lidDc);
  restoreSetting(runPowercfg, SUB_SLEEP, STANDBYIDLE, saved.sleepAc, saved.sleepDc);
  restoreSetting(runPowercfg, SUB_SLEEP, HIBERNATEIDLE, saved.hibAc, saved.hibDc);
  runPowercfg(["/setactive", "SCHEME_CURRENT"]);
};

// --- Crash-recovery file (Electron userData) --------------------------------

const resolveUserDataDir = (override: string | null | undefined): string | null => {
  if (typeof override === "string") {
    return override;
  }
  if (override === null) {
    return null;
  }
  try {
    const electron = Electron as unknown as {
      readonly app?: { readonly getPath?: (name: string) => string };
    };
    const dir = electron.app?.getPath?.("userData");
    return typeof dir === "string" && dir.length > 0 ? dir : null;
  } catch {
    // userData unavailable (e.g. app not ready): skip the recovery file.
    return null;
  }
};

const recoveryFilePath = (userDataDir: string | null): string | null =>
  userDataDir === null ? null : NodePath.join(userDataDir, KEEP_AWAKE_RECOVERY_FILE_NAME);

const writeRecoveryFile = (file: string | null, saved: KeepAwakeSavedSettings): void => {
  if (file === null) {
    return;
  }
  try {
    NodeFs.writeFileSync(file, JSON.stringify(saved), "utf8");
  } catch {
    // Best-effort: without the file we just lose crash recovery for this session.
  }
};

const deleteRecoveryFile = (file: string | null): void => {
  if (file === null) {
    return;
  }
  try {
    NodeFs.rmSync(file, { force: true });
  } catch {
    // Best-effort cleanup; a stale file is picked up by init recovery next launch.
  }
};

const readNumberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const sanitizeSavedSettings = (input: unknown): KeepAwakeSavedSettings | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return {
    lidAc: readNumberField(record, "lidAc"),
    lidDc: readNumberField(record, "lidDc"),
    sleepAc: readNumberField(record, "sleepAc"),
    sleepDc: readNumberField(record, "sleepDc"),
    hibAc: readNumberField(record, "hibAc"),
    hibDc: readNumberField(record, "hibDc"),
  };
};

/**
 * Best-effort restore for a previous session that died while enabled.
 * Returns true when a recovery file existed (so the caller logs it).
 */
const recoverPreviousSession = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  recoveryFile: string | null,
): boolean => {
  if (recoveryFile === null) {
    return false;
  }
  let found = false;
  try {
    found = NodeFs.existsSync(recoveryFile);
  } catch {
    return false;
  }
  if (!found) {
    return false;
  }
  try {
    const saved = sanitizeSavedSettings(
      JSON.parse(NodeFs.readFileSync(recoveryFile, "utf8")) as unknown,
    );
    if (saved !== null) {
      restorePowerSettings(runPowercfg, saved);
    }
  } catch {
    // Corrupt file: fall through to delete + log below.
  }
  deleteRecoveryFile(recoveryFile);
  return true;
};

/**
 * Minimal structural view of `Electron.powerSaveBlocker`, kept as an
 * interface (instead of using the Electron type directly) so the service can
 * be built with a fake in tests and degrade to `supported: false` where the
 * real API does not exist (web / unsupported platforms).
 */
export interface DesktopKeepAwakePowerSaveBlocker {
  readonly start: (type: DesktopKeepAwakeBlockerType) => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

interface PowerSaveBlockerLike {
  readonly start?: unknown;
  readonly stop?: unknown;
  readonly isStarted?: unknown;
}

const resolveDefaultBlocker = (): DesktopKeepAwakePowerSaveBlocker | null => {
  try {
    const electron = Electron as unknown as { readonly powerSaveBlocker?: PowerSaveBlockerLike };
    const candidate = electron.powerSaveBlocker;
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate.start === "function" &&
      typeof candidate.stop === "function" &&
      typeof candidate.isStarted === "function"
    ) {
      return candidate as unknown as DesktopKeepAwakePowerSaveBlocker;
    }
    return null;
  } catch {
    // Web builds / anything without the Electron main API: unsupported, not fatal.
    return null;
  }
};

const unsupportedState: DesktopKeepAwakeState = {
  enabled: false,
  supported: false,
  blockerType: KEEP_AWAKE_BLOCKER_TYPE,
};

export interface DesktopKeepAwakeOptions {
  readonly powerSaveBlocker?: DesktopKeepAwakePowerSaveBlocker | null | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly runPowercfg?: ((args: ReadonlyArray<string>) => string) | undefined;
  readonly applyExecutionState?: ((on: boolean) => Effect.Effect<void, never, never>) | undefined;
  readonly userDataDir?: string | null | undefined;
  readonly reassertInterval?: Duration.Duration | undefined;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (
  options?: DesktopKeepAwakeOptions,
): Effect.Effect<DesktopKeepAwake["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const blocker = options?.powerSaveBlocker ?? resolveDefaultBlocker();
    const supported = blocker !== null;
    const platform = options?.platform ?? process.platform;
    const isWindows = platform === "win32";
    const runPowercfg = options?.runPowercfg ?? defaultRunPowercfg;
    const applyExecutionState = options?.applyExecutionState ?? defaultApplyExecutionState;
    const reassertInterval = options?.reassertInterval ?? KEEP_AWAKE_REASSERT_INTERVAL;
    // Resolved lazily (not once at init): app.getPath("userData") can be
    // unavailable this early, which would otherwise disable crash recovery
    // for the entire session.
    const getRecoveryFile = (): string | null =>
      recoveryFilePath(resolveUserDataDir(options?.userDataDir));

    const currentId = yield* Ref.make(Option.none<number>());
    // Present while enabled on Windows: the user's original power values.
    // Doubles as the off→on save guard — re-enable never re-saves our own
    // forced values over the originals.
    const savedSettings = yield* Ref.make<KeepAwakeSavedSettings | null>(null);

    // Crash recovery: a previous session died while enabled and left its
    // recovery file behind. Restore those values + /setactive, delete the
    // file, log it. Fresh sessions start disabled either way.
    const recovered = yield* Effect.sync(() =>
      isWindows ? recoverPreviousSession(runPowercfg, getRecoveryFile()) : false,
    );
    if (recovered) {
      yield* Effect.logWarning(
        "[keep-awake] Restored power settings left behind by a previous session and removed the recovery file.",
      );
    }

    // Best-effort stop that can never fail: teardown paths (disable, app quit)
    // must not crash. (A crash mid-session is covered by the recovery file.)
    const stopId = (id: number): void => {
      if (blocker === null) return;
      try {
        blocker.stop(id);
      } catch {
        // Intentionally ignored — see above.
      }
    };

    const stopCurrent = Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(currentId, Option.none<number>());
      if (Option.isSome(previous)) {
        yield* Effect.sync(() => stopId(previous.value));
      }
    });

    // Save originals only on the off→on transition, persist the recovery
    // file, then force lid=Do Nothing + sleep/hibernate=never and assert the
    // thread execution state. All native calls are best-effort.
    const enableWindowsPower: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const existing = yield* Ref.get(savedSettings);
      if (existing === null) {
        const [lidAc, lidDc] = querySetting(runPowercfg, SUB_BUTTONS, LIDACTION);
        const [sleepAc, sleepDc] = querySetting(runPowercfg, SUB_SLEEP, STANDBYIDLE);
        const [hibAc, hibDc] = querySetting(runPowercfg, SUB_SLEEP, HIBERNATEIDLE);
        const saved: KeepAwakeSavedSettings = { lidAc, lidDc, sleepAc, sleepDc, hibAc, hibDc };
        yield* Ref.set(savedSettings, saved);
        yield* Effect.sync(() => writeRecoveryFile(getRecoveryFile(), saved));
      }
      yield* Effect.sync(() => forcePowerSettings(runPowercfg));
      yield* Effect.ignore(applyExecutionState(true));
    });

    // Restore all six saved values + /setactive, clear the guard, delete the
    // recovery file, and release the thread execution state.
    const restoreWindowsPower: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const existing = yield* Ref.getAndSet(savedSettings, null);
      yield* Effect.sync(() => {
        if (existing !== null) {
          restorePowerSettings(runPowercfg, existing);
        }
        deleteRecoveryFile(getRecoveryFile());
      });
      yield* Effect.ignore(applyExecutionState(false));
    });

    // Re-assert while enabled: something else (or the user) can rewrite the
    // power plan or clear the thread state out from under us. Scoped to the
    // layer, so the loop dies with the service and never outlives the app.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(reassertInterval);
          const saved = yield* Ref.get(savedSettings);
          if (saved !== null) {
            yield* Effect.sync(() => forcePowerSettings(runPowercfg));
            yield* Effect.ignore(applyExecutionState(true));
          }
        }
      }),
    );

    const getState: Effect.Effect<DesktopKeepAwakeState, never, never> = Effect.gen(function* () {
      const current = yield* Ref.get(currentId);
      return {
        enabled: supported && Option.isSome(current),
        supported,
        blockerType: KEEP_AWAKE_BLOCKER_TYPE,
      };
    });

    const setEnabled = Effect.fn("desktop.keepAwake.setEnabled")(function* (enabled: boolean) {
      if (!supported || blocker === null) {
        return unsupportedState;
      }
      if (!enabled) {
        yield* stopCurrent;
        if (isWindows) {
          yield* restoreWindowsPower;
        }
        return yield* getState;
      }
      const current = yield* Ref.get(currentId);
      if (Option.isSome(current)) {
        let alive = false;
        try {
          alive = blocker.isStarted(current.value);
        } catch {
          alive = false;
        }
        if (alive) {
          if (isWindows) {
            // Self-heal: blocker held but no saved originals (should not
            // happen, but forced power without restore data must never stand).
            const saved = yield* Ref.get(savedSettings);
            if (saved === null) {
              yield* enableWindowsPower;
            }
          }
          // Idempotent re-enable: keep holding the live blocker.
          return yield* getState;
        }
        // Stale id (e.g. the OS released it out from under us) — drop it and
        // acquire a fresh blocker below.
        yield* Ref.set(currentId, Option.none<number>());
      }
      // Defensive: never hold two blockers at once.
      yield* stopCurrent;
      if (isWindows) {
        yield* enableWindowsPower;
      }
      let id: number | null = null;
      try {
        // Brutal mode: the display stays on, even with the lid closed.
        id = blocker.start(KEEP_AWAKE_BLOCKER_TYPE);
      } catch {
        id = null;
      }
      if (typeof id !== "number") {
        // Could not hold the blocker: roll back any power changes just made
        // so a failed enable never leaves the system forced awake.
        if (isWindows) {
          yield* restoreWindowsPower;
        }
        return unsupportedState;
      }
      yield* Ref.set(currentId, Option.some(id));
      return yield* getState;
    });

    // Restore on layer-scope close (app quit): the same restore path as
    // disable, and it can never throw.
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(currentId, Option.none<number>());
        if (Option.isSome(previous)) {
          const id = previous.value;
          yield* Effect.sync(() => stopId(id));
        }
        if (isWindows) {
          const existing = yield* Ref.getAndSet(savedSettings, null);
          yield* Effect.sync(() => {
            if (existing !== null) {
              restorePowerSettings(runPowercfg, existing);
            }
            deleteRecoveryFile(getRecoveryFile());
          });
          yield* Effect.ignore(applyExecutionState(false));
        }
      }).pipe(Effect.ignoreCause),
    );

    return DesktopKeepAwake.of({ getState, setEnabled });
  });

export const layer = Layer.effect(DesktopKeepAwake, make());

/** Test seam: build the layer around an explicit (possibly null) blocker. */
export const layerWithBlocker = (powerSaveBlocker: DesktopKeepAwakePowerSaveBlocker | null) =>
  Layer.effect(DesktopKeepAwake, make({ powerSaveBlocker }));
