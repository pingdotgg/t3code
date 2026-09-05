import type { TerminalAttachStreamEvent } from "@t3tools/contracts";

// Bound retained OSC text independently of terminal scrollback.
const MAX_OSC_LENGTH = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// oxlint-disable-next-line no-control-regex -- C0 bytes are handled by the outer VT parser.
const oscControl = /[\x00-\x1f]/g;

type ClipboardWriteResult = "written" | "failed" | "skipped";

/** Shares one serialized writer per client, with at most one pending clipboard payload. */
export function createTerminalClipboardWriter(
  writeText: (text: string) => Promise<unknown> | undefined,
) {
  // OSC writers share one system clipboard. Retain only the newest pending copy
  // while a clipboard write is in flight, so slow permission checks cannot build a backlog.
  let writingClipboard = false;
  let pendingClipboardWrite: {
    text: string;
    canWrite: () => boolean;
    resolve: (result: ClipboardWriteResult) => void;
  } | null = null;

  function writeTerminalClipboard(
    text: string,
    canWrite: () => boolean = () => true,
  ): Promise<ClipboardWriteResult> {
    return new Promise((resolve) => {
      pendingClipboardWrite?.resolve("skipped");
      pendingClipboardWrite = { text, canWrite, resolve };
      if (!writingClipboard) void drainClipboardWrites();
    });
  }

  async function drainClipboardWrites(): Promise<void> {
    writingClipboard = true;
    while (pendingClipboardWrite) {
      const request = pendingClipboardWrite;
      pendingClipboardWrite = null;
      let result: ClipboardWriteResult = "skipped";
      try {
        if (request.canWrite()) {
          const write = writeText(request.text);
          if (write === undefined) result = "failed";
          else {
            await write;
            result = "written";
          }
        }
      } catch {
        result = "failed";
      }
      request.resolve(result);
    }
    writingClipboard = false;
  }
  return writeTerminalClipboard;
}

function decodeClipboardPayload(osc: string): string | null {
  if (!osc.startsWith("52;")) return null;
  const separator = osc.indexOf(";", 3);
  if (separator === -1) return null;
  const target = osc.slice(3, separator);
  // Empty targets use the system clipboard. Queries never read or send the
  // client's clipboard to a PTY; application selection buffers stay local.
  if (target !== "" && (!/^[cpqs0-7]+$/.test(target) || !target.includes("c"))) return null;
  const encoded = osc.slice(separator + 1);
  if (encoded === "") return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Observes 7-bit OSC framing in live output independently of native renderer replays.
 * libghostty parses OSC payloads only after the caller has framed them, so the
 * framing lives here for both clients.
 */
export class TerminalClipboardParser {
  private state: "ground" | "escape" | "osc" | "oscEscape" = "ground";
  // Null means this sequence has no clipboard payload worth retaining.
  private payload: string | null = null;
  private eligible = false;
  private escapeEligible = false;

  private readonly onWrite: (text: string) => void;

  constructor(onWrite: (text: string) => void) {
    this.onWrite = onWrite;
  }

  reset(): void {
    this.state = "ground";
    this.invalidatePendingCopy();
  }

  /** Revokes a pending copy on focus/visibility loss without losing VT framing. */
  invalidatePendingCopy(): void {
    this.payload = null;
    this.eligible = false;
    this.escapeEligible = false;
  }

  private beginEscape(eligible: boolean): void {
    this.state = "escape";
    this.payload = null;
    this.eligible = eligible;
  }

  /** Ineligible chunks still advance parsing, so replay cannot become a live copy. */
  write(data: string, eligible: boolean): void {
    if (!eligible) this.invalidatePendingCopy();
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!;
      if (char === "\x18" || char === "\x1a") {
        this.reset();
        continue;
      }
      switch (this.state) {
        case "ground": {
          // ESC also exits DCS/APC/PM/SOS, so their payloads need no separate state.
          const escape = data.indexOf("\x1b", index);
          if (escape === -1) return;
          index = escape;
          this.beginEscape(eligible);
          break;
        }
        case "escape":
          if (char === "]") {
            this.state = "osc";
            this.payload = this.eligible ? "" : null;
          } else if (char === "\x1b") {
            this.beginEscape(eligible);
          } else if (char >= " " && char !== "\x7f") {
            this.state = "ground";
          }
          break;
        case "osc":
          if (char === "\x07") {
            this.finish();
          } else if (char === "\x1b") {
            this.state = "oscEscape";
            this.escapeEligible = eligible;
          } else if (char < " ") {
            // Ghostty ignores other C0 bytes inside OSC, including wrapped lines.
          } else {
            oscControl.lastIndex = index;
            const control = oscControl.exec(data);
            const length = (control?.index ?? data.length) - index;
            if (this.payload !== null) {
              if (this.payload.length + length > MAX_OSC_LENGTH) {
                this.payload = null;
              } else {
                // Only the first three characters can disqualify the request. Checking
                // later would flatten the whole accumulated payload on every append.
                const checkPrefix = this.payload.length < 3;
                this.payload += data.slice(index, index + length);
                if (checkPrefix && !"52;".startsWith(this.payload.slice(0, 3))) this.payload = null;
              }
            }
            index += length - 1;
          }
          break;
        case "oscEscape":
          if (char === "\\") {
            this.finish();
          } else {
            // An ESC other than ST aborts the OSC and starts a new escape.
            this.beginEscape(this.escapeEligible);
            index -= 1;
          }
          break;
      }
    }
  }

  private finish(): void {
    const text =
      this.eligible && this.payload !== null ? decodeClipboardPayload(this.payload) : null;
    this.reset();
    if (text !== null) this.onWrite(text);
  }
}

/**
 * One client surface's live-copy policy over the parser: output copies only while
 * the surface is eligible, history never does, and copies parsed or queued before
 * the surface lost eligibility are revoked.
 */
export function createTerminalClipboardSession(options: {
  /** Read when output arrives and again before a queued write reaches the clipboard. */
  readonly isEligible: () => boolean;
  readonly onCopy: (text: string, canWrite: () => boolean) => void;
}) {
  let generation = 0;
  const parser = new TerminalClipboardParser((text) => {
    const requested = generation;
    options.onCopy(text, () => generation === requested && options.isEligible());
  });
  const reset = (history = "") => {
    generation += 1;
    parser.reset();
    parser.write(history, false);
  };
  return {
    /** Revokes copies on focus or visibility loss without losing VT framing. */
    invalidate(): void {
      generation += 1;
      parser.invalidatePendingCopy();
    },
    /** Session history and lifecycle events revoke copies; display resynchronization does not. */
    update(event: TerminalAttachStreamEvent): void {
      switch (event.type) {
        case "output":
          parser.write(event.data, options.isEligible());
          break;
        case "snapshot":
        case "restarted":
          reset(event.snapshot.history);
          break;
        case "cleared":
        case "closed":
        case "exited":
        case "error":
          reset();
          break;
        case "activity":
          break;
      }
    },
  };
}
