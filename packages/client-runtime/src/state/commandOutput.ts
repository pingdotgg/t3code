import type { OrchestrationV2CommandOutputFrame } from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  restoreTerminalOutput,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";

/** One command row's output as a client holds it. */
export interface CommandOutputView {
  readonly output: TerminalOutputState;
  /** False once the command settled and `output` is final. */
  readonly running: boolean;
}

export const EMPTY_COMMAND_OUTPUT: CommandOutputView = {
  output: EMPTY_TERMINAL_OUTPUT,
  running: true,
};

/**
 * Applies one server frame. A `replace` carries the whole bounded tail (the
 * first frame, a viewer that fell behind, or the final output); an `append`
 * is raw terminal text normalized with the same rules the server uses.
 */
export function applyCommandOutputFrame(
  view: CommandOutputView,
  frame: OrchestrationV2CommandOutputFrame,
): CommandOutputView {
  const output =
    frame.kind === "replace"
      ? restoreTerminalOutput(frame.text)
      : appendTerminalOutput(view.output, frame.text);
  return {
    output: { ...output, truncated: output.truncated || frame.truncated },
    running: frame.running,
  };
}
