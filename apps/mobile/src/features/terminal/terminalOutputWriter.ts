import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";

/** One writer per mounted native view; intermediate snapshots can be coalesced safely. */
export function createTerminalOutputWriter(
  writeOutput: (data: string, reset: boolean) => Promise<void>,
) {
  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let pending: TerminalOutputState | null = null;
  let draining: Promise<void> | null = null;
  let disposed = false;

  async function drain() {
    let recovering = false;
    try {
      while (pending !== null) {
        if (disposed) return;
        const output = pending;
        pending = null;
        const update = readTerminalOutputUpdate(output, cursor);
        if (update.type === "none") continue;
        try {
          await writeOutput(update.data, update.type === "reset");
        } catch (error) {
          if (disposed) return;
          // A rejected command may have partially applied. Replay the latest retained history
          // once per drain; a persistent native failure must settle instead of spinning.
          cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
          pending ??= output;
          if (recovering) throw error;
          recovering = true;
          continue;
        }
        cursor = update.cursor;
      }
    } finally {
      draining = null;
    }
  }

  return {
    write(output: TerminalOutputState): Promise<void> {
      if (disposed) return Promise.resolve();
      pending = output;
      draining ??= Promise.resolve().then(drain);
      return draining;
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
