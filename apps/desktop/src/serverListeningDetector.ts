const LISTENING_LOG_FRAGMENT = "Listening on http://";
const MAX_BUFFER_CHARS = 8_192;

export class ServerListeningDetector {
  private buffer = "";
  private settled = false;
  private readonly resolvePromise: () => void;
  private readonly rejectPromise: (error: unknown) => void;
  readonly promise: Promise<void>;

  constructor() {
    let resolvePromise: (() => void) | null = null;
    let rejectPromise: ((error: unknown) => void) | null = null;

    this.promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.resolvePromise = () => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      resolvePromise?.();
    };
    this.rejectPromise = (error) => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      rejectPromise?.(error);
    };
  }

  push(chunk: unknown): void {
    if (this.settled) {
      return;
    }

    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.buffer = `${this.buffer}${text.replace(/\r/g, "")}`;
    if (this.buffer.includes(LISTENING_LOG_FRAGMENT)) {
      this.resolvePromise();
      return;
    }

    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
    }
  }

  fail(error: unknown): void {
    this.rejectPromise(error);
  }
}
