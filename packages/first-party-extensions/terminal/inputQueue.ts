// @effect-diagnostics globalTimers:off -- The serialized-write deadline races a plain Promise in extension-host code, outside any Effect fiber.
/**
 * Bounded, ordered PTY input transport.
 *
 * Input batches against the serialized `t3.terminal/control` `write`
 * invocation — `{terminalId, data}` as JSON — not JS string length, because
 * the wire budget applies to the encoded request. On any write whose outcome
 * is unknown (transport failure, timeout, or a server-side error after the
 * request body was sent) the queue halts: the failed batch and everything
 * queued behind it are discarded and never resent — there is no op-id fence
 * to prove which bytes landed. Input stays stopped until the user
 * resumes explicitly; a restart/close resets the queue entirely.
 */
export const TERMINAL_INPUT_SERIALIZED_BUDGET = 48 * 1024;
export const TERMINAL_INPUT_PENDING_BUDGET = 256 * 1024;
export const TERMINAL_INPUT_WRITE_TIMEOUT_MS = 30_000;

const textEncoder = new TextEncoder();

/** UTF-8 bytes of the serialized write invocation for `data`. */
export function serializedWriteBytes(terminalId: string, data: string): number {
  return textEncoder.encode(JSON.stringify({ terminalId, data })).byteLength;
}

/** UTF-8 bytes of `JSON.stringify(data)`, quotes included. */
export function serializedStringBytes(data: string): number {
  return textEncoder.encode(JSON.stringify(data)).byteLength;
}

/**
 * Longest prefix of `data` whose JSON string body fits `maxEscapedBytes`,
 * never splitting a surrogate pair or a code point.
 */
export function serializedHead(data: string, maxEscapedBytes: number): string {
  if (maxEscapedBytes <= 0 || data.length === 0) return "";
  let used = 0;
  let units = 0;
  for (const char of data) {
    const cost = textEncoder.encode(JSON.stringify(char)).byteLength - 2;
    if (used + cost > maxEscapedBytes) break;
    used += cost;
    units += char.length;
  }
  return data.slice(0, units);
}

/**
 * Failures provably raised before the write body reached the PTY — decode,
 * scope, and authority checks run ahead of `TerminalManager.write`; the view
 * host's own gates never send the request at all.
 */
const PRE_WRITE_FAILURES = [
  "Terminal authority is unavailable.",
  "Terminal session is unavailable in the requested workspace.",
  "Terminal session cannot be inspected.",
  "Terminal control is scoped to the requested workspace.",
  "Terminal control takes the thread from the view context.",
  "Terminal control requires a thread scope.",
  "Terminal control method is unavailable.",
  "Invalid terminal control request.",
  "Capability denied",
  "Capability unavailable",
  "View is inactive",
  "Too many pending view calls",
];

export function isKnownNonWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PRE_WRITE_FAILURES.some((known) => message.includes(known));
}

export type TerminalInputEnqueue = "accepted" | "dropped-full" | "dropped-stopped";

export interface TerminalInputQueueState {
  /** Persistent stop: input halts and new input drops until `resume()`. */
  readonly stopped: boolean;
  /** Why input stopped; null while running. */
  readonly message: string | null;
  readonly queuedCount: number;
  readonly queuedBytes: number;
}

export class TerminalInputQueue {
  readonly #write: (data: string) => Promise<unknown>;
  readonly #onChange: (() => void) | undefined;
  readonly #serializedBudget: number;
  readonly #pendingBudget: number;
  readonly #writeTimeoutMs: number;
  readonly #overhead: number;
  #pending: { data: string; serialized: number }[] = [];
  #pendingSerialized = 0;
  #ready = true;
  #draining = false;
  #stopped: { message: string; outcome: "known" | "unknown" } | null = null;
  #disposed = false;
  #sendTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly terminalId: string;
    readonly write: (data: string) => Promise<unknown>;
    readonly onChange?: () => void;
    readonly serializedBudget?: number;
    readonly pendingBudget?: number;
    readonly writeTimeoutMs?: number;
  }) {
    this.#write = options.write;
    this.#onChange = options.onChange;
    this.#serializedBudget = options.serializedBudget ?? TERMINAL_INPUT_SERIALIZED_BUDGET;
    this.#pendingBudget = options.pendingBudget ?? TERMINAL_INPUT_PENDING_BUDGET;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? TERMINAL_INPUT_WRITE_TIMEOUT_MS;
    this.#overhead = serializedWriteBytes(options.terminalId, "");
  }

  get state(): TerminalInputQueueState {
    return {
      stopped: this.#stopped !== null,
      message: this.#stopped?.message ?? null,
      queuedCount: this.#pending.length,
      queuedBytes: this.#pendingSerialized,
    };
  }

  /**
   * Disposal is terminal for the queue object: a revived owner (StrictMode
   * effect replay) must construct a fresh queue rather than resurrect this
   * one — pending bytes dropped at dispose are never resent.
   */
  get disposed(): boolean {
    return this.#disposed;
  }

  enqueue(data: string): TerminalInputEnqueue {
    if (this.#disposed || this.#stopped !== null) return "dropped-stopped";
    if (data.length === 0) return "accepted";
    const serialized = serializedStringBytes(data);
    if (this.#pendingSerialized + serialized > this.#pendingBudget) {
      return "dropped-full";
    }
    this.#pending.push({ data, serialized });
    this.#pendingSerialized += serialized;
    this.#onChange?.();
    void this.#drain();
    return "accepted";
  }

  /** Gate draining while the session is starting; pending input accumulates. */
  setReady(ready: boolean) {
    if (this.#ready === ready) return;
    this.#ready = ready;
    if (ready) void this.#drain();
  }

  /** Explicit user resume after a stopped write; only post-resume input flows. */
  resume() {
    if (this.#stopped === null) return;
    this.#stopped = null;
    this.#onChange?.();
    void this.#drain();
  }

  /**
   * New process epoch (restart/open/attach), close, or stream close: pending
   * input is stale for the new incarnation and the stop reason no longer
   * applies, so both clear. In-flight writes still evaluate normally.
   */
  reset() {
    this.#pending = [];
    this.#pendingSerialized = 0;
    if (this.#stopped !== null) this.#stopped = null;
    this.#onChange?.();
  }

  dispose() {
    this.#disposed = true;
    this.#pending = [];
    this.#pendingSerialized = 0;
    clearTimeout(this.#sendTimer);
  }

  /**
   * Longest pending prefix whose serialized invocation fits the budget.
   * Consumed items leave the queue before the write is sent — on an unknown
   * outcome they are discarded, not requeued.
   */
  #takeBatch(): string {
    const escapedBudget = this.#serializedBudget - this.#overhead;
    const parts: string[] = [];
    let used = 0;
    let first = true;
    while (this.#pending.length > 0) {
      const item = this.#pending[0]!;
      const escaped = item.serialized - 2;
      if (used + escaped <= escapedBudget) {
        parts.push(item.data);
        used += escaped;
        this.#pendingSerialized -= item.serialized;
        this.#pending.shift();
        first = false;
        continue;
      }
      if (!first) break;
      const head = serializedHead(item.data, escapedBudget);
      if (head.length === 0) {
        // Cannot fit even one code point; drop the item rather than wedge.
        this.#pendingSerialized -= item.serialized;
        this.#pending.shift();
        continue;
      }
      const rest = item.data.slice(head.length);
      this.#pending[0] = { data: rest, serialized: serializedStringBytes(rest) };
      this.#pendingSerialized += this.#pending[0]!.serialized - item.serialized;
      parts.push(head);
      break;
    }
    return parts.join("");
  }

  async #send(data: string): Promise<void> {
    const timeout = new Promise<never>((_resolve, reject) => {
      this.#sendTimer = setTimeout(
        () => reject(new Error("Terminal write timed out")),
        this.#writeTimeoutMs,
      );
    });
    try {
      await Promise.race([this.#write(data), timeout]);
    } finally {
      clearTimeout(this.#sendTimer);
      this.#sendTimer = undefined;
    }
  }

  async #drain(): Promise<void> {
    if (!this.#ready || this.#stopped !== null || this.#draining || this.#disposed) return;
    this.#draining = true;
    try {
      while (this.#ready && this.#stopped === null && !this.#disposed && this.#pending.length > 0) {
        const batch = this.#takeBatch();
        if (batch.length === 0) continue;
        try {
          await this.#send(batch);
        } catch (error) {
          // The batch and everything behind it are dropped: without an op-id
          // fence there is no way to tell which bytes landed, and a paste
          // that lost its opening marker must never release the rest.
          this.#pending = [];
          this.#pendingSerialized = 0;
          const message = error instanceof Error ? error.message : "Terminal write failed";
          this.#stopped = isKnownNonWriteError(error)
            ? { message: `Input stopped — ${message}`, outcome: "known" }
            : {
                message: `Input stopped — the terminal may have received partial input (${message}). Resume to continue typing.`,
                outcome: "unknown",
              };
          break;
        }
      }
    } finally {
      this.#draining = false;
      this.#onChange?.();
    }
  }
}
