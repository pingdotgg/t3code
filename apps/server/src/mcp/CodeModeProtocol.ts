import * as Schema from "effect/Schema";

const Id = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 }));
const ExecutionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const HostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    executionId: ExecutionId,
    code: Schema.String.check(Schema.isMaxLength(32_000)),
    tools: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    executionId: ExecutionId,
    id: Id,
    failed: Schema.Boolean,
    value: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), executionId: ExecutionId }),
  Schema.Struct({ type: Schema.Literal("stats") }),
]);
export type HostMessage = typeof HostMessage.Type;
export const GuestMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), pid: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("started"),
    executionId: ExecutionId,
    threadId: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("call"),
    executionId: ExecutionId,
    id: Id,
    tool: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal("log"), executionId: ExecutionId, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    executionId: ExecutionId,
    failed: Schema.Boolean,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("stats"),
    pid: Schema.Int,
    rssBytes: Schema.Int,
    workers: Schema.Int,
  }),
]);
export type GuestMessage = typeof GuestMessage.Type;
export const decodeHostMessage = Schema.decodeUnknownSync(HostMessage);
export const decodeGuestMessage = Schema.decodeUnknownSync(GuestMessage);

/** Bounded UTF-8 frames, including incomplete lines. stdout is exclusively this protocol. */
export function frames(receive: (message: unknown) => void) {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if ((end < 0 ? pending.length : end) > 256 * 1024)
        throw new Error("Code host frame exceeds 256 KiB.");
      if (end < 0) return;
      const line = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      receive(JSON.parse(line));
    }
  };
}

/** Serial writes honor pipe backpressure; the bounded queue also covers a stalled reader. */
export function frameWriter(output: NodeJS.WritableStream) {
  let queued = 0;
  let writing = Promise.resolve();
  return (value: unknown) => {
    if (queued >= 256) return Promise.reject(new Error("Code host outgoing queue is full."));
    queued++;
    const next = writing.then(() => writeFrame(output, value));
    writing = next.catch(() => {});
    return next.finally(() => queued--);
  };
}

export function writeFrame(output: NodeJS.WritableStream, value: unknown) {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > 256 * 1024)
    return Promise.reject(new Error("Code host frame exceeds 256 KiB."));
  return new Promise<void>((resolve, reject) => {
    output.write(line, (error) => (error ? reject(error) : resolve()));
  });
}

export function bridgeError(error: unknown) {
  if (!(error instanceof Error)) return error;
  return {
    message: error.message.slice(0, 2_000),
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
  };
}
