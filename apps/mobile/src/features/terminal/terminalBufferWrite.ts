/**
 * The part of a `TerminalOutputUpdate` a write cares about: the cursor stays
 * with the reader.
 *
 * `TerminalOutputUpdate` 中与写入相关的部分：cursor 由读取方自己保管。
 */
interface TerminalOutputDelta {
  readonly type: "reset" | "append";
  readonly data: string;
}

/**
 * One incremental write handed to the native terminal surface. `seq` is
 * monotonic so the native side applies each write exactly once, and `reset`
 * marks the writes that must clear the grid before feeding `data`.
 */
export interface TerminalBufferWrite {
  readonly seq: number;
  readonly reset: boolean;
  readonly data: string;
}

export const IDLE_TERMINAL_BUFFER_WRITE: TerminalBufferWrite = Object.freeze({
  seq: 0,
  reset: false,
  data: "",
});

/**
 * Fold a new output update into the write the native view has not taken yet.
 *
 * React batches state updates, so several output events can collapse into one
 * commit — and only the final prop value reaches the native view. Merging
 * instead of overwriting keeps the batched output whole; a committed write is
 * already on screen, so the next update starts a fresh sequence.
 *
 * React 会把多次 state 更新合并成一次 commit，原生只会收到最后一个 prop 值。
 * 这里用合并而不是覆盖，保证批处理期间的输出不丢；已经提交过的写入原生已消费，
 * 下一次更新从新的序号开始。
 */
export function mergeTerminalBufferWrite(input: {
  readonly pending: TerminalBufferWrite;
  readonly committedSeq: number;
  readonly update: TerminalOutputDelta;
}): TerminalBufferWrite {
  const isReset = input.update.type === "reset";
  if (input.pending.seq <= input.committedSeq) {
    return {
      seq: input.pending.seq + 1,
      reset: isReset,
      data: input.update.data,
    };
  }

  // A reset supersedes whatever was still queued for the same commit.
  //
  // reset 会覆盖同一次 commit 中尚未送达的旧数据。
  if (isReset) {
    return { seq: input.pending.seq, reset: true, data: input.update.data };
  }

  return {
    seq: input.pending.seq,
    reset: input.pending.reset,
    data: input.pending.data + input.update.data,
  };
}
