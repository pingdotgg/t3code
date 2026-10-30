// @effect-diagnostics globalTimers:off - vendored upstream protocol, not an Effect service.
import { Buffer } from 'node:buffer';
import { badRequest, HttpError, tooLarge } from './errors.ts';

export class Deadline {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private cancelled: Promise<never>;
  private onAbort = () => this.controller.abort();
  constructor(
    ms: number,
    private signal?: AbortSignal,
  ) {
    this.timer = setTimeout(this.onAbort, ms);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.cancelled = new Promise((_, reject) =>
      this.controller.signal.addEventListener(
        'abort',
        () => reject(new HttpError(503, 'deadline')),
        { once: true },
      ),
    );
    // Cancellation can precede the first awaited operation.
    void this.cancelled.catch(() => {});
    if (signal?.aborted) this.onAbort();
  }
  check(): void {
    if (this.controller.signal.aborted) throw new HttpError(503, 'deadline');
  }
  async run<T>(operation: Promise<T>): Promise<T> {
    this.check();
    return Promise.race([operation, this.cancelled]);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}

export async function collect(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  let size = 0;
  // Fixed-capacity accumulation also bounds bookkeeping for one-byte chunks.
  const buffer = new Uint8Array(limit);
  for await (const chunk of source) {
    if (chunk.length > limit - size) tooLarge();
    buffer.set(chunk, size);
    size += chunk.length;
  }
  return buffer.subarray(0, size);
}

export class Input {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array = new Uint8Array(0);
  private offset = 0;
  bytes = 0;
  ended = false;
  buffer: Buffer = Buffer.alloc(0);
  constructor(
    body: ReadableStream<Uint8Array> | null,
    private max: number,
    private deadline: Deadline,
  ) {
    if (!body) badRequest();
    this.reader = body.getReader();
  }
  async fill(): Promise<boolean> {
    if (this.ended) return false;
    if (this.offset === this.pending.length) {
      const result = await this.deadline.run(this.reader.read());
      if (result.done) {
        this.ended = true;
        return false;
      }
      this.bytes += result.value.length;
      if (this.bytes > this.max) tooLarge();
      this.pending = result.value;
      this.offset = 0;
    }
    const next = this.pending.subarray(this.offset, this.offset + 64 * 1024);
    this.offset += next.length;
    this.buffer = Buffer.concat([this.buffer, next]);
    return true;
  }
  take(size: number): Buffer {
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
  async until(delimiter: Buffer, limit: number): Promise<Buffer> {
    while (true) {
      const index = this.buffer.indexOf(delimiter);
      if (index >= 0) {
        if (index > limit) tooLarge();
        const value = this.take(index);
        this.take(delimiter.length);
        return value;
      }
      if (this.buffer.length > limit + delimiter.length) tooLarge();
      if (!(await this.fill())) badRequest();
    }
  }
  async *rest(): AsyncGenerator<Uint8Array> {
    do {
      if (this.buffer.length) yield this.take(this.buffer.length);
    } while (await this.fill());
  }
  close(): void {
    void this.reader.cancel().catch(() => {});
  }
}

export async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  deadline: Deadline,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Input(body, limit, deadline);
  try {
    return await collect(input.rest(), limit);
  } finally {
    input.close();
  }
}

export function contentLength(request: Request, maximum: number): number | null {
  const raw = request.headers.get('Content-Length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) badRequest();
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximum) tooLarge();
  return length;
}
