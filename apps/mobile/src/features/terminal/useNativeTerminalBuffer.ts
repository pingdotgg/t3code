import {
  readTerminalOutputUpdate,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { useCallback, useMemo, useState } from "react";

/** Offsets count UTF-16 code units on both native platforms, as string.length does in JS. */
export interface TerminalBufferWrite {
  readonly generation: number;
  readonly offset: number;
  readonly data: string;
}

function synchronize(terminalKey: string, output: TerminalOutputState, generation: number) {
  return {
    terminalKey,
    generation,
    sourceGeneration: output.generation,
    resetVersion: output.resetVersion,
    baseOffset: output.chunks[0]?.startOffset ?? output.nextOffset,
    offset: 0,
    nextOffset: output.nextOffset,
  };
}

export function useNativeTerminalBuffer(terminalKey: string, output: TerminalOutputState) {
  const [state, setState] = useState(() => synchronize(terminalKey, output, 1));
  let current = state;
  let update = readTerminalOutputUpdate(output, {
    generation: current.sourceGeneration,
    resetVersion: current.resetVersion,
    offset: current.baseOffset + current.offset,
  });
  if (state.terminalKey !== terminalKey || update.type === "reset") {
    current = synchronize(terminalKey, output, state.generation + 1);
    setState(current);
    update = readTerminalOutputUpdate(output, {
      generation: current.sourceGeneration,
      resetVersion: current.resetVersion,
      offset: current.baseOffset,
    });
  } else if (current.nextOffset !== output.nextOffset) {
    current = { ...current, nextOffset: output.nextOffset };
    setState(current);
  }

  const { generation, offset } = current;
  const data = update.type === "none" ? "" : update.data;
  const bufferWrite = useMemo(() => ({ generation, offset, data }), [data, generation, offset]);
  const acknowledge = useCallback(
    (ack: { readonly generation: number; readonly offset: number }) => {
      setState((previous) => {
        if (
          previous.terminalKey !== terminalKey ||
          previous.generation !== ack.generation ||
          !Number.isSafeInteger(ack.offset) ||
          ack.offset <= previous.offset ||
          ack.offset > previous.nextOffset - previous.baseOffset
        )
          return previous;
        return { ...previous, offset: ack.offset };
      });
    },
    [terminalKey],
  );

  // Keep all unacknowledged output in each prop update. React or Fabric can skip intermediate commits.
  return { bufferWrite, acknowledge };
}
