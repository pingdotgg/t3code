import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
} from "@t3tools/client-runtime/state/terminal";
import { type DaemonId, daemonTerminalTarget, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { terminalEnvironment } from "../../state/terminal";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { synchronizeTerminalOutput, terminalThemeFromApp } from "../ThreadTerminalDrawer";

const ignoreInput = () => {};

/** Follows a daemon's terminal read-only: typing must not reach the daemon. */
export default function DaemonsTerminal({
  environmentId,
  daemonId,
}: {
  readonly environmentId: EnvironmentId;
  readonly daemonId: DaemonId;
}) {
  const result = useAtomValue(
    terminalEnvironment.observe({ environmentId, input: daemonTerminalTarget(daemonId) }),
  );
  const buffer = AsyncResult.getOrElse(result, () => EMPTY_TERMINAL_BUFFER_STATE);
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(INITIAL_TERMINAL_OUTPUT_CURSOR);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes new daemon output into the imperative Ghostty terminal surface
  useEffect(() => {
    if (surface) cursor.current = synchronizeTerminalOutput(surface, buffer, cursor.current);
  }, [surface, buffer]);
  const mountSurface = (element: HTMLDivElement) => {
    let disposed = false;
    let created: GhosttyTerminalSurface | null = null;
    void GhosttyTerminalSurface.create(element, {
      theme: terminalThemeFromApp(element),
      font: { size: 12 },
      onData: ignoreInput,
      onBinary: ignoreInput,
      onReply: ignoreInput,
      onResize: ignoreInput,
      onSelectionChange: ignoreInput,
      beforeKey: () => true,
      onLinkActivate: (url) => {
        if (/^https?:\/\//i.test(url))
          void ensureLocalApi()
            .shell.openExternal(url)
            .catch(() => setError("Could not open the link."));
      },
    })
      .then((terminal) => {
        if (disposed) {
          terminal.dispose();
          return;
        }
        created = terminal;
        cursor.current = INITIAL_TERMINAL_OUTPUT_CURSOR;
        setSurface(terminal);
      })
      .catch(() => setError("Could not load the terminal."));
    return () => {
      disposed = true;
      created?.dispose();
      setSurface(null);
    };
  };
  return (
    <>
      <div
        ref={mountSurface}
        aria-label="Daemon terminal"
        className="relative h-[60vh] overflow-hidden rounded-md border border-border"
      />
      {result._tag === "Failure" ? (
        <p role="status" className="text-sm text-muted-foreground">
          This daemon has no terminal yet. Enable it to start one.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
