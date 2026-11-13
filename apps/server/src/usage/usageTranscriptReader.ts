// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the scan worker pool runs outside the Effect runtime.
// Cold windows span ~1.4 GB/1,500 files; node:fs buffer streaming is ~10x cheaper than materializing files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import type {
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Resume only if bytes before resumeOffset match the guard hash; rewritten files would corrupt totals. */
export interface TranscriptParsePosition {
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface TranscriptParseResult {
  readonly records: readonly UsageRecord[];
  /** Unterminated tail records stay outside records/position so the next scan rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Includes tentative tail diagnostics; position.state only includes committed lines. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
  readonly resumed: boolean;
}

export const GUARD_LENGTH = 64;
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const STAT_CONCURRENCY = 32;
const WALK_CONCURRENCY = 16;
// Measured about 3x faster than the promise API's stat across 20,000 transcripts.
const statFile = NodeUtil.promisify(NodeFS.stat);
const CARRIAGE_RETURN = 0x0d;

function selectUsageFields(fields: SelectedFields) {
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      if (typeof key !== "string" || !Object.hasOwn(selected, key)) return false;
      selected = selected[key]!;
    }
    return true;
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Skips Grok logs without usage; preserves readdir order for first-seen deduplication. */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<{
  readonly files: readonly TranscriptFile[];
  readonly walked: readonly string[];
  readonly failedPaths: number;
}> {
  const fileName = options?.fileName;
  let failedPaths = 0;
  let reading = 0;
  const waiting: Array<() => void> = [];
  // Sibling directories read together; each returns its own list so the result keeps readdir order.
  const walk = async (dir: string): Promise<readonly string[]> => {
    if (reading < WALK_CONCURRENCY) reading += 1;
    else await new Promise<void>((resume) => waiting.push(resume));
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      return [];
    } finally {
      // A waiting directory takes over this slot, so the count only drops when none waits.
      const next = waiting.shift();
      if (next === undefined) reading -= 1;
      else next();
    }
    const found = await Promise.all(
      entries.map((entry) => {
        const child = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) return walk(child);
        return (
          fileName !== undefined
            ? entry.name === fileName
            : entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst")
        )
          ? [child]
          : [];
      }),
    );
    return found.flat();
  };
  const candidates = await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await statFile(path);
        if (stats.mtimeMs >= sinceMs) {
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), walked: candidates, failedPaths };
}

export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

const LINE = 0;
const PIECE = 1;
const LINE_END = 2;
const TAIL = 3;
// Parallel parsing beyond UsageService's four concurrent reads would only queue.
const SCAN_WORKERS = 4;
const SCAN_WORKER_IDLE_MS = 10_000;

interface ScanJob {
  readonly fd: number;
  readonly start: number;
  readonly compressed: boolean;
  readonly streamingThresholdBytes: number;
  readonly marker?: string;
  readonly pattern?: string;
}

/** Each part ends at `ends[i]` in `bytes`; parts arrive in file order. */
interface ScanBatch {
  readonly kinds: readonly number[];
  readonly ends: readonly number[];
  readonly bytes: ArrayBuffer;
  readonly resumeOffset: number;
  readonly done: boolean;
  /** On the last batch: the unterminated tail is a line too large to buffer. */
  readonly streaming: boolean;
}

// Splitting and gating lines is most of a scan's CPU, so it runs off the main thread; the
// main thread parses only lines that pass the gate, in order, so totals and state are unchanged.
// Inline source also runs in bundles and single-executable builds without module files.
const scanWorkerSource = `
const { parentPort } = require("node:worker_threads");
const NodeFS = require("node:fs");
const NodeStream = require("node:stream");
const NodeZlib = require("node:zlib");
const NEWLINE = 0x0a;
const READ_CHUNK_BYTES = ${READ_CHUNK_BYTES};
const BATCH_BYTES = 1024 * 1024;
const [LINE, PIECE, LINE_END, TAIL] = [${LINE}, ${PIECE}, ${LINE_END}, ${TAIL}];
const EMPTY = Buffer.alloc(0);

const read = (fd, buffer, position) =>
  new Promise((resolve, reject) =>
    NodeFS.read(fd, buffer, 0, buffer.length, position, (error, bytesRead) =>
      error ? reject(error) : resolve(bytesRead),
    ),
  );

// A reused buffer is only valid until the next chunk is requested.
async function* fileChunks(job, reuse) {
  let buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (let position = job.start; ; ) {
    const bytesRead = await read(job.fd, buffer, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
    if (!reuse) buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  }
}

function readChunks(job) {
  if (!job.compressed) return fileChunks(job, true);
  // Compressed snapshots cache a full parse; decoded offsets cannot resume the compressed input.
  // Not an fs stream: destroying one closes the main thread's descriptor even without autoClose.
  return NodeStream.Readable.from(fileChunks(job, false), { objectMode: false }).compose(
    NodeZlib.createZstdDecompress(),
  );
}

async function* scan(job) {
  let passes;
  if (job.marker !== undefined) {
    const marker = Buffer.from(job.marker);
    passes = (line) => line.includes(marker);
  } else {
    // latin1 maps each byte to one character, so ASCII markers match exactly where their bytes do.
    const pattern = new RegExp(job.pattern);
    passes = (line) => pattern.test(line.toString("latin1"));
  }
  let kinds = [];
  let parts = [];
  let bytes = 0;
  const push = (kind, part) => {
    kinds.push(kind);
    parts.push(part);
    bytes += part.length;
  };
  let resumeOffset = job.start;
  let scanOffset = job.start;
  let pending = [];
  let pendingBytes = 0;
  let streaming = false;
  const batch = (done) => {
    // An unpooled buffer owns its ArrayBuffer, so it can be transferred without a copy.
    const out = Buffer.allocUnsafeSlow(bytes);
    const ends = [];
    let offset = 0;
    for (const part of parts) {
      part.copy(out, offset);
      offset += part.length;
      ends.push(offset);
    }
    const result = { kinds, ends, bytes: out.buffer, resumeOffset, done, streaming };
    kinds = [];
    parts = [];
    bytes = 0;
    return result;
  };
  const append = (segment) => {
    if (!streaming && pendingBytes + segment.length <= job.streamingThresholdBytes) {
      // Copy: the next read overwrites the chunk this segment points into.
      if (segment.length > 0) pending.push(Buffer.from(segment));
      pendingBytes += segment.length;
      return;
    }
    if (!streaming) {
      streaming = true;
      for (const part of pending) push(PIECE, part);
      pending = [];
      pendingBytes = 0;
    }
    if (segment.length > 0) push(PIECE, Buffer.from(segment));
  };
  const pendingLine = () =>
    pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
  let consumed = 0;
  for await (const chunk of readChunks(job)) {
    let lineStart = 0;
    while (lineStart < chunk.length) {
      const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
      if (newlineIndex === -1) {
        append(chunk.subarray(lineStart));
        break;
      }
      if (!streaming && pendingBytes === 0) {
        const line = chunk.subarray(lineStart, newlineIndex);
        if (passes(line)) push(LINE, Buffer.from(line));
      } else {
        append(chunk.subarray(lineStart, newlineIndex));
        if (streaming) push(LINE_END, EMPTY);
        else if (pendingBytes > 0) {
          const line = pendingLine();
          if (passes(line)) push(LINE, line);
        }
        pending = [];
        pendingBytes = 0;
        streaming = false;
      }
      lineStart = newlineIndex + 1;
      resumeOffset = scanOffset + lineStart;
    }
    scanOffset += chunk.length;
    consumed += chunk.length;
    if (consumed >= BATCH_BYTES || bytes >= BATCH_BYTES) {
      consumed = 0;
      yield batch(false);
    }
  }
  if (!streaming && pendingBytes > 0) {
    const line = pendingLine();
    if (passes(line)) push(TAIL, line);
  }
  yield batch(true);
}

let job;
let ahead;
const prefetch = () => {
  ahead = job.next();
  // Rejections are reported when the main thread asks for this batch.
  ahead.catch(() => {});
};
parentPort.on("message", async (message) => {
  if (message.type === "start") {
    job = scan(message.job);
    prefetch();
  }
  try {
    const { value } = await ahead;
    if (!value.done) prefetch();
    parentPort.postMessage(value, [value.bytes]);
  } catch (error) {
    parentPort.postMessage({ error: String(error && error.message ? error.message : error) });
  }
});
`;

interface ScanWorker {
  readonly thread: NodeWorkerThreads.Worker;
  failed: boolean;
  pending?: { resolve: (reply: unknown) => void; reject: (error: unknown) => void } | undefined;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const idleWorkers: ScanWorker[] = [];
const waitingForWorker: Array<(worker: ScanWorker) => void> = [];
let liveWorkers = 0;

function spawnScanWorker(): ScanWorker {
  liveWorkers += 1;
  const worker: ScanWorker = {
    thread: new NodeWorkerThreads.Worker(scanWorkerSource, { eval: true }),
    failed: false,
  };
  const settle = (outcome: { reply: unknown } | { error: unknown }) => {
    const pending = worker.pending;
    worker.pending = undefined;
    if (pending === undefined) return;
    if ("reply" in outcome) pending.resolve(outcome.reply);
    else pending.reject(outcome.error);
  };
  worker.thread.on("message", (reply) => settle({ reply }));
  const fail = (error: unknown) => {
    worker.failed = true;
    settle({ error });
  };
  worker.thread.on("error", fail);
  worker.thread.on("exit", () => fail(new Error("Transcript scan worker exited.")));
  return worker;
}

async function acquireScanWorker(): Promise<ScanWorker> {
  for (let worker = idleWorkers.pop(); worker !== undefined; worker = idleWorkers.pop()) {
    clearTimeout(worker.idleTimer);
    if (worker.failed) {
      liveWorkers -= 1;
      continue;
    }
    worker.thread.ref();
    return worker;
  }
  if (liveWorkers < SCAN_WORKERS) return spawnScanWorker();
  return new Promise((resolve) => waitingForWorker.push(resolve));
}

function releaseScanWorker(worker: ScanWorker, reusable: boolean): void {
  if (!reusable || worker.failed) {
    liveWorkers -= 1;
    void worker.thread.terminate();
    const waiting = waitingForWorker.shift();
    if (waiting !== undefined) waiting(spawnScanWorker());
    return;
  }
  const waiting = waitingForWorker.shift();
  if (waiting !== undefined) return waiting(worker);
  worker.thread.unref();
  worker.idleTimer = setTimeout(() => {
    const index = idleWorkers.indexOf(worker);
    if (index === -1) return;
    idleWorkers.splice(index, 1);
    liveWorkers -= 1;
    void worker.thread.terminate();
  }, SCAN_WORKER_IDLE_MS).unref();
  idleWorkers.push(worker);
}

async function* scanTranscript(job: ScanJob): AsyncGenerator<ScanBatch> {
  const worker = await acquireScanWorker();
  let finished = false;
  try {
    for (let message: object = { type: "start", job }; ; message = { type: "next" }) {
      const reply = await new Promise<ScanBatch | { readonly error: string }>((resolve, reject) => {
        worker.pending = { resolve: resolve as (reply: unknown) => void, reject };
        worker.thread.postMessage(message);
      });
      if ("error" in reply) {
        finished = true;
        throw new Error(reply.error);
      }
      if (reply.done) finished = true;
      yield reply;
      if (reply.done) return;
    }
  } finally {
    // An abandoned scan still has a batch in flight, so its worker is not reused.
    releaseScanWorker(worker, finished);
  }
}

/** Returns null on read failure; caching it as empty would hide usage until size/mtime changes. */
export async function readTranscriptRecords<State>(
  filePath: string,
  format: TranscriptUsageFormat<State>,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number },
): Promise<TranscriptParseResult | null> {
  const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
  const compressed = filePath.endsWith(".jsonl.zst");
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    const codec = format.state;
    const decodeState = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
    const encodeState = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
    let state = codec === undefined ? (undefined as State) : codec.initial();
    let resumed = false;
    let start = 0;
    const savedState =
      resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
        ? Option.none()
        : decodeState(resumeFrom.state);
    if (
      !compressed &&
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (codec === undefined || Option.isSome(savedState)) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (Option.isSome(savedState)) state = savedState.value;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const parseLine = (lineBuffer: Buffer, lineState: State, out: UsageRecord[]): void => {
      for (const record of format.parseLine(toLineString(lineBuffer), lineState)) out.push(record);
    };

    const records: UsageRecord[] = [];
    let resumeOffset = start;
    let tail: Buffer | undefined;
    let tailStreaming = false;
    let streaming:
      | {
          readonly reader: ReturnType<typeof createTranscriptJsonReader>;
          readonly decoder: NodeStringDecoder.StringDecoder;
        }
      | undefined;
    const selectPath = selectUsageFields(format.selectFields);
    // Usage has no import-history budget; retain selected fields regardless of surrounding tool payload size.
    const startStreaming = () => ({
      reader: createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity }),
      decoder: new NodeStringDecoder.StringDecoder("utf8"),
    });
    const finishStreaming = (lineState: State, out: UsageRecord[]) => {
      const { reader, decoder } = streaming ?? startStreaming();
      streaming = undefined;
      reader.write(decoder.end());
      for (const record of format.parseProjected(reader.finish(), lineState)) out.push(record);
    };

    const [firstMarker, ...otherMarkers] = format.usageMarkers;
    const job: ScanJob = {
      fd: handle.fd,
      start,
      compressed,
      streamingThresholdBytes,
      ...(otherMarkers.length === 0
        ? { marker: firstMarker }
        : {
            pattern: format.usageMarkers
              .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("|"),
          }),
    };
    for await (const batch of scanTranscript(job)) {
      const bytes = Buffer.from(batch.bytes);
      let partStart = 0;
      for (const [index, kind] of batch.kinds.entries()) {
        const part = bytes.subarray(partStart, batch.ends[index]);
        partStart = batch.ends[index]!;
        if (kind === LINE) parseLine(part, state, records);
        else if (kind === PIECE) {
          streaming ??= startStreaming();
          streaming.reader.write(streaming.decoder.write(part));
        } else if (kind === LINE_END) finishStreaming(state, records);
        else tail = part;
      }
      resumeOffset = batch.resumeOffset;
      tailStreaming = batch.done && batch.streaming;
    }

    // Parse unfinished tails against copied state so the next scan can replay from resumeOffset.
    const encodedState = encodeState === undefined ? null : encodeState(state);
    const tailRecords: UsageRecord[] = [];
    const tailState =
      decodeState === undefined ? state : Option.getOrThrow(decodeState(encodedState));
    if (tailStreaming) finishStreaming(tailState, tailRecords);
    else if (tail !== undefined) parseLine(tail, tailState, tailRecords);

    const guardLength = compressed ? 0 : Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      malformedRecords: format.readMalformedRecords?.(tailState) ?? 0,
      position: {
        resumeOffset: compressed ? 0 : resumeOffset,
        guardLength,
        guardHash,
        state: encodedState,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
