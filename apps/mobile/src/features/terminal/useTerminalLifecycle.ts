import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import { useEffect, useEffectEvent, useRef } from "react";

/** Keep observed history passive while preserving explicit terminal visits and live exits. */
export function useTerminalLifecycle({
  terminalKey,
  canOperate,
  observing,
  attached,
  terminal,
  reopen,
  onRunning,
  onExit,
}: {
  readonly terminalKey: string;
  readonly canOperate: boolean;
  readonly observing: boolean;
  readonly attached: boolean;
  readonly terminal: Pick<TerminalSessionState, "status" | "version">;
  readonly reopen: () => Promise<boolean>;
  readonly onRunning: () => void;
  readonly onExit: () => void;
}) {
  const lifecycle = useRef({
    key: terminalKey,
    wasRunning: false,
    observed: false,
    reopened: false,
  });
  const reopenTerminal = useEffectEvent(reopen);
  const handleRunning = useEffectEvent(onRunning);
  const handleExit = useEffectEvent(onExit);

  useEffect(() => {
    if (lifecycle.current.key !== terminalKey) {
      lifecycle.current = {
        key: terminalKey,
        wasRunning: false,
        observed: false,
        reopened: false,
      };
    }
    const current = lifecycle.current;
    if (!canOperate) {
      // An observe request stays passive before its first snapshot arrives.
      if (observing || terminal.version > 0 || current.wasRunning) current.observed = true;
      current.wasRunning = false;
      return;
    }
    if (!attached) {
      current.wasRunning = false;
      return;
    }
    // An attachment without its first snapshot has no known process status yet.
    if (terminal.version === 0) return;

    if (terminal.status === "running" || terminal.status === "starting") {
      current.wasRunning = true;
      current.reopened = false;
      handleRunning();
      return;
    }
    if (terminal.status !== "closed" && terminal.status !== "exited") return;

    if (current.wasRunning) {
      current.wasRunning = false;
      current.reopened = true;
      handleExit();
      return;
    }
    // An explicit visit can reopen a cached ended session. Granting a viewer
    // operate permission must leave the history they were reading intact.
    if (current.observed || current.reopened) return;
    current.reopened = true;
    void reopenTerminal().then((succeeded) => {
      if (!succeeded && lifecycle.current === current) current.reopened = false;
    });
  }, [attached, canOperate, observing, terminal.status, terminal.version, terminalKey]);
}
