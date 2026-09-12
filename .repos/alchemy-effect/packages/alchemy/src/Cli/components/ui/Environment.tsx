/** @jsxImportSource react */
import { useWindowSize } from "@alchemy.run/sigil";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CliKitCapabilities } from "../types.ts";
import { glyphsFor, theme, type KeyHint } from "../../../Util/Theme.ts";

const defaults: CliKitCapabilities = {
  input: false,
  columns: 80,
  rows: 24,
  colors: false,
  unicode: true,
  alternateScreen: false,
};

const EnvironmentContext = createContext<CliKitCapabilities>(defaults);

/**
 * Resize-following variant, split out so the static renderer (`renderToString`
 * for every print/format) never attaches a `resize` listener to stdout.
 */
type ObservingEnvironmentProps = {
  readonly capabilities: CliKitCapabilities;
  readonly children?: ReactNode;
};

function ObservingEnvironment({
  capabilities,
  children,
}: ObservingEnvironmentProps) {
  const window = useWindowSize();
  const environment = useMemo(
    () => ({ ...capabilities, columns: window.columns, rows: window.rows }),
    [capabilities, window.columns, window.rows],
  );
  return (
    <EnvironmentContext.Provider value={environment}>
      {children}
    </EnvironmentContext.Provider>
  );
}

type CliEnvironmentProps = {
  readonly capabilities: CliKitCapabilities;
  /** Follow Sigil's terminal resize subscription for a live renderer. */
  readonly observeWindow?: boolean;
  readonly children?: ReactNode;
};

export function CliEnvironment({
  capabilities,
  observeWindow = false,
  children,
}: CliEnvironmentProps) {
  return observeWindow ? (
    <ObservingEnvironment capabilities={capabilities}>
      {children}
    </ObservingEnvironment>
  ) : (
    <EnvironmentContext.Provider value={capabilities}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export const useCliEnvironment = () => useContext(EnvironmentContext);

export const useGlyphs = () => glyphsFor(useCliEnvironment().unicode);

/** Border style matching the terminal's Unicode capability. */
export const useBorderStyle = () =>
  useCliEnvironment().unicode ? ("single" as const) : ("classic" as const);

const asciiKeyHint: KeyHint = {
  enter: "enter",
  upDown: "up/down",
  leftRight: "left/right",
  escape: "esc",
  space: "space",
  tab: "tab",
  yesNo: "y/n",
};

/** Key-hint labels for `KeyBar` footers, honoring the ASCII fallback. */
export const useKeyGlyphs = (): KeyHint =>
  useCliEnvironment().unicode ? theme.keyHint : asciiKeyHint;
