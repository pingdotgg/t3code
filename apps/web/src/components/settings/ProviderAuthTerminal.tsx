import type { ProviderAuthResponse } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { ensureLocalApi } from "../../localApi";
import { useStableCallback } from "../../hooks/useStableCallback";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";

export default function ProviderAuthTerminal({
  output,
  outputOffset,
  onResponse,
}: {
  readonly output: string;
  readonly outputOffset?: number | undefined;
  readonly onResponse: (response: Extract<ProviderAuthResponse, { type: "terminal" }>) => void;
}) {
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null);
  const written = useRef(0);
  const [error, setError] = useState<string | null>(null);
  // The surface captures its callbacks once at creation.
  const respond = useStableCallback(onResponse);
  const offset = outputOffset ?? output.length;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes new auth output into the imperative Ghostty terminal surface
  useEffect(() => {
    if (!surface) return;
    const delta = offset - written.current;
    if (delta > 0 && delta <= output.length) surface.write(output.slice(-delta));
    else if (delta !== 0) surface.resetAndWrite(output);
    written.current = offset;
  }, [surface, output, offset]);
  const mountSurface = (element: HTMLDivElement) => {
    let disposed = false;
    let created: GhosttyTerminalSurface | null = null;
    void GhosttyTerminalSurface.create(element, {
      theme: terminalThemeFromApp(element),
      font: { size: 13 },
      onData: (data) => respond({ type: "terminal", data }),
      onResize: (cols, rows) => respond({ type: "terminal", data: "", size: { cols, rows } }),
      onSelectionChange: () => {},
      beforeKey: (event) => event.key !== "Tab",
      onLinkActivate: (url) => {
        if (/^https?:\/\//i.test(url))
          void ensureLocalApi()
            .shell.openExternal(url)
            .catch(() => setError("Could not open the provider link."));
      },
    })
      .then((terminal) => {
        if (disposed) {
          terminal.dispose();
          return;
        }
        created = terminal;
        written.current = 0;
        setSurface(terminal);
      })
      .catch(() => setError("Could not load the sign-in terminal. Cancel and retry sign-in."));
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
        aria-label="Provider sign-in terminal"
        className="relative h-64 overflow-hidden rounded-md border border-border"
      />
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
