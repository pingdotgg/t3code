export class ExtensionEventLane {
  private tail = Promise.resolve();
  private count = 0;
  private bytes = 0;
  private closed = false;
  private overflowReported = false;
  private readonly options: {
    maxEvents: number;
    maxBytes: number;
    onError: (cause: unknown) => void;
    onOverflow: () => void;
  };

  constructor(options: ExtensionEventLane["options"]) {
    this.options = options;
  }

  enqueue(bytes: number, deliver: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.count >= this.options.maxEvents || this.bytes + bytes > this.options.maxBytes) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.options.onOverflow();
      }
      return Promise.resolve();
    }
    this.count++;
    this.bytes += bytes;
    this.tail = this.tail.then(async () => {
      try {
        if (!this.closed) await deliver();
      } catch (cause) {
        this.options.onError(cause);
      } finally {
        this.count--;
        this.bytes -= bytes;
        if (this.count === 0) this.overflowReported = false;
      }
    });
    return this.tail;
  }

  close() {
    this.closed = true;
  }
}
