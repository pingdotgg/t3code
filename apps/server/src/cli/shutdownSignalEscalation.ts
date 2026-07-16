// @effect-diagnostics nodeBuiltinImport:off - This module is the CLI process and signal boundary.
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ShutdownSignalProcessHooks {
  readonly addSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly removeSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly exit: (code: number) => void;
}

export interface ShutdownSignalTimerHooks<TimerHandle> {
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

export interface ShutdownSignalEscalationOptions<TimerHandle> {
  readonly process: ShutdownSignalProcessHooks;
  readonly timers: ShutdownSignalTimerHooks<TimerHandle>;
  readonly forceExitAfterMs?: number;
}

const defaultForceExitAfterMs = 10_000;

const conventionalExitCode = (signal: ShutdownSignal) => (signal === "SIGINT" ? 130 : 143);

export const installShutdownSignalEscalation = <TimerHandle>({
  process: processHooks,
  timers,
  forceExitAfterMs = defaultForceExitAfterMs,
}: ShutdownSignalEscalationOptions<TimerHandle>) => {
  let firstSignal: ShutdownSignal | undefined;
  let forceExitTimer: { readonly handle: TimerHandle } | undefined;
  let disposed = false;

  const clearForceExitTimer = () => {
    if (forceExitTimer === undefined) return;
    timers.clearTimeout(forceExitTimer.handle);
    forceExitTimer = undefined;
  };

  const forceExit = (signal: ShutdownSignal) => {
    clearForceExitTimer();
    processHooks.exit(conventionalExitCode(signal));
  };

  const handleSignal = (signal: ShutdownSignal) => {
    if (firstSignal !== undefined) {
      forceExit(signal);
      return;
    }

    firstSignal = signal;
    forceExitTimer = {
      handle: timers.setTimeout(() => {
        forceExitTimer = undefined;
        processHooks.exit(conventionalExitCode(signal));
      }, forceExitAfterMs),
    };
  };

  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");

  processHooks.addSignalListener("SIGINT", handleSigint);
  processHooks.addSignalListener("SIGTERM", handleSigterm);

  return () => {
    if (disposed) return;
    disposed = true;
    processHooks.removeSignalListener("SIGINT", handleSigint);
    processHooks.removeSignalListener("SIGTERM", handleSigterm);
    clearForceExitTimer();
  };
};

export const installNodeShutdownSignalEscalation = () =>
  installShutdownSignalEscalation({
    process: {
      addSignalListener: (signal, listener) => {
        NodeProcess.on(signal, listener);
      },
      removeSignalListener: (signal, listener) => {
        NodeProcess.removeListener(signal, listener);
      },
      exit: (code) => NodeProcess.exit(code),
    },
    timers: {
      // @effect-diagnostics-next-line globalTimers:off - The forced exit deadline must outlive a stuck Effect shutdown.
      setTimeout: (callback, delayMs) => NodeTimers.setTimeout(callback, delayMs),
      clearTimeout: (handle) => NodeTimers.clearTimeout(handle),
    },
  });
