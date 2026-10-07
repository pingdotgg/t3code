import type { ProviderAuthResponse } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { ensureLocalApi } from "../../localApi";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";

/** Loaded only for an interactive login. PTY input is serialized by the parent. */
export default function ProviderAuthTerminal({
  output,
  outputOffset,
  onResponse,
}: {
  readonly output: string;
  readonly outputOffset?: number | undefined;
  readonly onResponse: (response: Extract<ProviderAuthResponse, { type: "terminal" }>) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const surface = useRef<GhosttyTerminalSurface | null>(null);
  const latest = useRef({ output, offset: outputOffset ?? output.length, onResponse });
  const written = useRef(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    latest.current = { output, offset: outputOffset ?? output.length, onResponse };
    const terminal = surface.current;
    if (!terminal) return;
    const delta = latest.current.offset - written.current;
    if (delta > 0 && delta <= output.length) terminal.write(output.slice(-delta));
    else if (delta !== 0) terminal.resetAndWrite(output);
    written.current = latest.current.offset;
  }, [output, outputOffset, onResponse]);
  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    let disposed = false;
    void GhosttyTerminalSurface.create(element, {
      theme: terminalThemeFromApp(element),
      font: { size: 13 },
      onData: (data) => latest.current.onResponse({ type: "terminal", data }),
      onResize: (cols, rows) =>
        latest.current.onResponse({ type: "terminal", data: "", size: { cols, rows } }),
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
        surface.current = terminal;
        terminal.write(latest.current.output);
        written.current = latest.current.offset;
      })
      .catch(() => setError("Could not load the sign-in terminal. Cancel and retry sign-in."));
    return () => {
      disposed = true;
      surface.current?.dispose();
      surface.current = null;
    };
  }, []);
  return (
    <>
      <div
        ref={mount}
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
