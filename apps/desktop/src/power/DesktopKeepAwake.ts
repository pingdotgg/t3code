// @effect-diagnostics nodeBuiltinImport:off -- This Windows platform boundary drives powercfg via spawnSync (windowsHide) and reads/writes the userData crash-recovery file with Node.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

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
 *   hibernate-after AC/DC) are saved per power scheme GUID on first touch
 *   (guarded by a `Ref` map, so re-enable and the reassert loop never
 *   clobber the originals with our own forced values), then each touched
 *   scheme is restored to its own originals on disable. Saving by scheme —
 *   never by the `SCHEME_CURRENT` alias — is what keeps a mid-session power
 *   plan switch from permanently corrupting the previous plan.
 * - The saved values are also persisted to a JSON recovery file under
 *   Electron `userData` (`app.getPath("userData")`, best-effort — skipped
 *   when unavailable), deleted on clean disable/restore. If a previous
 *   session crashed or was killed while enabled, the first service use
 *   finds the file, best-effort restores those values + `/setactive`,
 *   deletes it, and logs. The check is deferred to first use (not layer
 *   construction) because layers build before `DesktopApp` sets Electron's
 *   final `userData` path — an init-time lookup would read the wrong
 *   directory and miss the file.
 * - Every power/blocker transition (enable, disable, reassert tick, quit
 *   finalizer) is serialized through a 1-permit semaphore: `setEnabled`
 *   suspends on the `ffi-rs` load, so overlapping toggles could otherwise
 *   double-start blockers and orphan one.
 * - A `forkScoped` 25 s re-assert loop re-applies the forced values and the
 *   execution state while still enabled (checks the `Ref` map, tracking
 *   newly switched-to plans as it goes; dies with the layer scope).
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

/**
 * Original power values per scheme: scheme GUID (or the
 * `SCHEME_CURRENT` alias when the GUID was unresolvable) → settings.
 * Keying by scheme is what makes a mid-session power plan switch safe.
 */
export type KeepAwakeSavedByScheme = ReadonlyMap<string, KeepAwakeSavedSettings>;

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

// Every helper below targets an explicit scheme: either a GUID resolved
// from `/getactivescheme` or the `SCHEME_CURRENT` alias as a last resort.
// Saving and restoring by scheme — never by alias — is what keeps a
// mid-session power plan switch from permanently corrupting the previous
// plan: each touched scheme is restored to its own originals.
const SCHEME_CURRENT_ALIAS = "SCHEME_CURRENT";

const SCHEME_GUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Resolve the active power scheme GUID (`powercfg /getactivescheme` prints
// `Power Scheme GUID: <guid> (<name>)`). Undefined when powercfg fails or
// the output is unparseable — callers fall back to the `SCHEME_CURRENT`
// alias for that operation only.
const getActiveSchemeGuid = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
): string | undefined => {
  const out = runPowercfg(["/getactivescheme"]);
  if (out.length === 0) {
    return undefined;
  }
  const match =
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.exec(out);
  return match?.[0];
};

// Read the current AC and DC index for one power setting on one scheme.
const querySetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
  sub: string,
  setting: string,
): readonly [number | undefined, number | undefined] => {
  const acOut = runPowercfg(["/getacvalueindex", scheme, sub, setting]);
  const dcOut = runPowercfg(["/getdcvalueindex", scheme, sub, setting]);
  return [parseFirstHex(acOut), parseFirstHex(dcOut)];
};

// Read all three overridden settings on one scheme.
const querySchemeSettings = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
): KeepAwakeSavedSettings => {
  const [lidAc, lidDc] = querySetting(runPowercfg, scheme, SUB_BUTTONS, LIDACTION);
  const [sleepAc, sleepDc] = querySetting(runPowercfg, scheme, SUB_SLEEP, STANDBYIDLE);
  const [hibAc, hibDc] = querySetting(runPowercfg, scheme, SUB_SLEEP, HIBERNATEIDLE);
  return { lidAc, lidDc, sleepAc, sleepDc, hibAc, hibDc };
};

// Set one power setting's AC and DC index (no /setactive — caller batches it).
const setSetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
  sub: string,
  setting: string,
  value: number,
): void => {
  const v = value.toString();
  runPowercfg(["/setacvalueindex", scheme, sub, setting, v]);
  runPowercfg(["/setdcvalueindex", scheme, sub, setting, v]);
};

// Restore one setting's AC/DC index if we recorded originals for it.
const restoreSetting = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
  sub: string,
  setting: string,
  ac: number | undefined,
  dc: number | undefined,
): void => {
  if (ac !== undefined) {
    runPowercfg(["/setacvalueindex", scheme, sub, setting, ac.toString()]);
  }
  if (dc !== undefined) {
    runPowercfg(["/setdcvalueindex", scheme, sub, setting, dc.toString()]);
  }
};

// Force lid=Do Nothing and sleep/hibernate timeouts to 0 (never) on one
// scheme, batched with a single /setactive like Brutal Awake.
const forceSchemeSettings = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
): void => {
  setSetting(runPowercfg, scheme, SUB_BUTTONS, LIDACTION, 0); // 0 = Do nothing on lid close
  setSetting(runPowercfg, scheme, SUB_SLEEP, STANDBYIDLE, 0); // 0 = never sleep
  setSetting(runPowercfg, scheme, SUB_SLEEP, HIBERNATEIDLE, 0); // 0 = never hibernate
  runPowercfg(["/setactive", SCHEME_CURRENT_ALIAS]);
};

// Put one scheme's overridden settings back to what the user had (no
// /setactive — the caller batches one after restoring every scheme).
const restoreSchemeSettings = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
  saved: KeepAwakeSavedSettings,
): void => {
  restoreSetting(runPowercfg, scheme, SUB_BUTTONS, LIDACTION, saved.lidAc, saved.lidDc);
  restoreSetting(runPowercfg, scheme, SUB_SLEEP, STANDBYIDLE, saved.sleepAc, saved.sleepDc);
  restoreSetting(runPowercfg, scheme, SUB_SLEEP, HIBERNATEIDLE, saved.hibAc, saved.hibDc);
};

// Restore every touched scheme to its own originals, then reactivate once.
const restoreAllSchemes = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  saved: KeepAwakeSavedByScheme,
): void => {
  if (saved.size === 0) {
    return;
  }
  for (const [scheme, settings] of saved) {
    restoreSchemeSettings(runPowercfg, scheme, settings);
  }
  runPowercfg(["/setactive", SCHEME_CURRENT_ALIAS]);
};

// Read back one scheme and confirm every overridden value is 0 (never /
// Do Nothing). powercfg writes fail silently without elevation, and
// reporting success then would leave the toggle lying about protection
// the machine does not have.
const verifySchemeForced = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
): boolean => {
  const forced = querySchemeSettings(runPowercfg, scheme);
  return (
    forced.lidAc === 0 &&
    forced.lidDc === 0 &&
    forced.sleepAc === 0 &&
    forced.sleepDc === 0 &&
    forced.hibAc === 0 &&
    forced.hibDc === 0
  );
};

// Confirm one scheme matches the originals we recorded. Only used after a
// restore, where a mismatch yields a warning — disable is best-effort,
// since there is nothing sensible to roll back to.
const verifySchemeRestored = (
  runPowercfg: (args: ReadonlyArray<string>) => string,
  scheme: string,
  saved: KeepAwakeSavedSettings,
): boolean => {
  const current = querySchemeSettings(runPowercfg, scheme);
  const fields = [
    [current.lidAc, saved.lidAc],
    [current.lidDc, saved.lidDc],
    [current.sleepAc, saved.sleepAc],
    [current.sleepDc, saved.sleepDc],
    [current.hibAc, saved.hibAc],
    [current.hibDc, saved.hibDc],
  ] as const;
  return fields.every(([actual, expected]) => expected === undefined || actual === expected);
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

const writeRecoveryFile = (file: string | null, saved: KeepAwakeSavedByScheme): void => {
  if (file === null) {
    return;
  }
  try {
    NodeFs.writeFileSync(file, JSON.stringify(Object.fromEntries(saved)), "utf8");
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

const sanitizeSavedByScheme = (input: unknown): KeepAwakeSavedByScheme | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const result = new Map<string, KeepAwakeSavedSettings>();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!SCHEME_GUID_PATTERN.test(key) && key !== SCHEME_CURRENT_ALIAS) {
      continue;
    }
    const saved = sanitizeSavedSettings(value);
    if (saved !== null) {
      result.set(key, saved);
    }
  }
  return result;
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
    const saved = sanitizeSavedByScheme(
      JSON.parse(NodeFs.readFileSync(recoveryFile, "utf8")) as unknown,
    );
    if (saved !== null) {
      restoreAllSchemes(runPowercfg, saved);
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
    // Original power values keyed by scheme GUID, non-empty while enabled
    // on Windows. Doubles as the save guard — re-enable and the reassert
    // loop never re-save our own forced values over the originals.
    const savedByScheme = yield* Ref.make(new Map<string, KeepAwakeSavedSettings>());
    // Serializes every power/blocker transition: setEnabled suspends on the
    // ffi-rs load, so overlapping toggles could otherwise double-start
    // blockers and orphan one. All entry points below take this lock.
    const transitionMutex = yield* Semaphore.make(1);
    // Crash-recovery check, deferred to first use instead of layer
    // construction: layers build before DesktopApp sets Electron's final
    // userData path, so an init-time lookup would read the wrong directory
    // and miss the file. The first IPC call necessarily happens after
    // setPath. Idempotent — runs at most once per process.
    const recoveryChecked = yield* Ref.make(false);
    const ensureRecoveryChecked: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const done = yield* Ref.getAndSet(recoveryChecked, true);
      if (done || !isWindows) {
        return;
      }
      const recovered = yield* Effect.sync(() =>
        recoverPreviousSession(runPowercfg, getRecoveryFile()),
      );
      if (recovered) {
        yield* Effect.logWarning(
          "[keep-awake] Restored power settings left behind by a previous session and removed the recovery file.",
        );
      }
    });

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

    // Save one scheme's originals on first touch (guarded by the map, so we
    // never record our own forced values), persist the recovery file, then
    // force lid=Do Nothing + sleep/hibernate=never on the active scheme and
    // assert the thread execution state. All native calls are best-effort.
    // Callers must hold the transition mutex.
    const ensureSchemeSaved = (scheme: string): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const saved = yield* Ref.get(savedByScheme);
        if (saved.has(scheme)) {
          return;
        }
        const next = new Map(saved);
        next.set(scheme, querySchemeSettings(runPowercfg, scheme));
        yield* Ref.set(savedByScheme, next);
        yield* Effect.sync(() => writeRecoveryFile(getRecoveryFile(), next));
      });

    // Returns true when the force landed. A false means the powercfg
    // writes did not take effect (e.g. no elevation) — callers roll back
    // rather than claim protection the machine does not have.
    const enableWindowsPower: Effect.Effect<boolean, never, never> = Effect.gen(function* () {
      const scheme = getActiveSchemeGuid(runPowercfg) ?? SCHEME_CURRENT_ALIAS;
      yield* ensureSchemeSaved(scheme);
      yield* Effect.sync(() => forceSchemeSettings(runPowercfg, scheme));
      const forced = yield* Effect.sync(() => verifySchemeForced(runPowercfg, scheme));
      yield* Effect.ignore(applyExecutionState(true));
      return forced;
    });

    // Restore every touched scheme to its own originals + /setactive, clear
    // the guard, delete the recovery file, release the execution state.
    // Callers must hold the transition mutex.
    const restoreWindowsPower: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const saved = yield* Ref.getAndSet(savedByScheme, new Map<string, KeepAwakeSavedSettings>());
      const unverified = yield* Effect.sync(() => {
        restoreAllSchemes(runPowercfg, saved);
        deleteRecoveryFile(getRecoveryFile());
        const bad: Array<string> = [];
        for (const [scheme, settings] of saved) {
          if (!verifySchemeRestored(runPowercfg, scheme, settings)) {
            bad.push(scheme);
          }
        }
        return bad;
      });
      if (unverified.length > 0) {
        yield* Effect.logWarning(
          `[keep-awake] Restored power settings but could not confirm ${unverified.length} scheme(s); values may still be forced.`,
        );
      }
      yield* Effect.ignore(applyExecutionState(false));
    });

    // Re-assert while enabled: something else (or the user) can rewrite the
    // power plan or clear the thread state out from under us — including
    // switching plans, which we then track as a newly touched scheme.
    // Scoped to the layer, so the loop dies with the service.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(reassertInterval);
          yield* transitionMutex.withPermits(1)(
            Effect.gen(function* () {
              const saved = yield* Ref.get(savedByScheme);
              if (saved.size === 0) {
                return;
              }
              yield* Effect.ignore(applyExecutionState(true));
              const scheme = getActiveSchemeGuid(runPowercfg) ?? SCHEME_CURRENT_ALIAS;
              yield* ensureSchemeSaved(scheme);
              yield* Effect.sync(() => forceSchemeSettings(runPowercfg, scheme));
            }),
          );
        }
      }),
    );

    const readState: Effect.Effect<DesktopKeepAwakeState, never, never> = Effect.gen(function* () {
      const current = yield* Ref.get(currentId);
      return {
        enabled: supported && Option.isSome(current),
        supported,
        blockerType: KEEP_AWAKE_BLOCKER_TYPE,
      };
    });

    const getState: Effect.Effect<DesktopKeepAwakeState, never, never> =
      transitionMutex.withPermits(1)(
        Effect.gen(function* () {
          yield* ensureRecoveryChecked;
          return yield* readState;
        }),
      );

    const runTransition = Effect.fn("desktop.keepAwake.transition")(function* (enabled: boolean) {
      if (!supported || blocker === null) {
        return unsupportedState;
      }
      if (!enabled) {
        yield* stopCurrent;
        if (isWindows) {
          yield* restoreWindowsPower;
        }
        return yield* readState;
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
            const saved = yield* Ref.get(savedByScheme);
            if (saved.size === 0) {
              const forced = yield* enableWindowsPower;
              if (!forced) {
                yield* restoreWindowsPower;
              }
            }
          }
          // Idempotent re-enable: keep holding the live blocker.
          return yield* readState;
        }
        // Stale id (e.g. the OS released it out from under us) — drop it and
        // acquire a fresh blocker below.
        yield* Ref.set(currentId, Option.none<number>());
      }
      // Defensive: never hold two blockers at once.
      yield* stopCurrent;
      if (isWindows) {
        const forced = yield* enableWindowsPower;
        if (!forced) {
          // The powercfg writes did not land (e.g. no elevation): roll back
          // so a failed enable never claims protection the machine lacks.
          yield* Effect.logWarning(
            "[keep-awake] Could not force power settings (powercfg writes need elevation); rolled back.",
          );
          yield* restoreWindowsPower;
          return yield* readState;
        }
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
      return yield* readState;
    });

    const setEnabled = Effect.fn("desktop.keepAwake.setEnabled")(function* (enabled: boolean) {
      return yield* transitionMutex.withPermits(1)(
        Effect.gen(function* () {
          yield* ensureRecoveryChecked;
          return yield* runTransition(enabled);
        }),
      );
    });

    // Restore on layer-scope close (app quit): the same restore path as
    // disable, and it can never throw.
    yield* Effect.acquireRelease(Effect.void, () =>
      transitionMutex
        .withPermits(1)(
          Effect.gen(function* () {
            yield* stopCurrent;
            if (isWindows) {
              yield* restoreWindowsPower;
            }
          }),
        )
        .pipe(Effect.ignoreCause),
    );

    return DesktopKeepAwake.of({ getState, setEnabled });
  });

export const layer = Layer.effect(DesktopKeepAwake, make());

/** Test seam: build the layer around an explicit (possibly null) blocker. */
export const layerWithBlocker = (powerSaveBlocker: DesktopKeepAwakePowerSaveBlocker | null) =>
  Layer.effect(DesktopKeepAwake, make({ powerSaveBlocker }));
