import { detectCapabilities } from "@alchemy.run/sigil/capabilities";
import type { TerminalCapabilities, TerminalOptions } from "../../Interaction.ts";
import { isNonInteractive } from "../../Util/interactive.ts";

/** Detect what the terminal behind the given streams supports. */
export const resolveCapabilities = (options: TerminalOptions = {}): TerminalCapabilities => {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const detected = detectCapabilities({ stdout });
  const input =
    options.input ?? (stdin.isTTY === true && stdout.isTTY === true && !isNonInteractive());
  return {
    input,
    columns: detected.size.columns,
    rows: detected.size.rows,
    colors: options.colors ?? detected.supports.color,
    unicode: options.unicode ?? detected.supports.unicode,
    alternateScreen: detected.supports.alternateScreen,
  };
};
