import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { useClosedViewStore } from "~/closedViewStore";
import type {
  RightPanelSurface,
  ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

const READING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POSITION_PREFIX = "t3code.fileReading.v1:";
const RECEIPT_PREFIX = "t3code.fileReveal.v1:";
const POSITION_CAP = 300;
const RECEIPT_CAP = 200;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ReadingPosition = Schema.Union([
  /** `offset` is the viewport top minus the line top, so it is zero or negative. */
  Schema.Struct({ view: Schema.Literal("source"), line: PositiveInt, offset: Schema.Finite }),
  /** `block` is a top-level Markdown block; `fraction` is how far the viewport top is into it. */
  Schema.Struct({
    view: Schema.Literal("rendered"),
    block: Index,
    fraction: Schema.Finite.check(
      Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMaximum: true }),
    ),
  }),
  Schema.Struct({
    view: Schema.Literal("pdf"),
    page: Index,
    offset: Schema.Finite,
    zoom: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))),
    left: Schema.Finite,
  }),
]);
export type ReadingPosition = typeof ReadingPosition.Type;
export type ReadingView = ReadingPosition["view"];
export type ReadingPositionOf<V extends ReadingView> = Extract<ReadingPosition, { view: V }>;

/** `closed` marks a tab closed after its reveal was shown; only Reopen Closed View brings it back. */
const RevealReceipt = Schema.Struct({
  id: PositiveInt,
  line: PositiveInt,
  closed: Schema.optionalKey(Schema.Literal(true)),
});
export type RevealReceipt = typeof RevealReceipt.Type;

const EntryHeader = Schema.Struct({ v: Schema.Literal(1), at: Schema.Finite });
const decodeHeader = Schema.decodeUnknownOption(EntryHeader);
const decodeReceiptKey = Schema.decodeUnknownOption(Schema.Tuple([Schema.String, Schema.String]));

export interface FileReadingKey {
  readonly environmentId: string;
  readonly absolutePath: string;
}

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Entry<A> {
  readonly at: number;
  readonly value: A;
}

/** One key per entry under `prefix`; `index` holds every live storage key, oldest first. */
interface Table<A> {
  readonly prefix: string;
  readonly cap: number;
  readonly decode: (input: unknown) => Option.Option<A>;
  readonly index: Map<string, number>;
  readonly written: Map<string, Entry<A>>;
}

function table<A>(
  prefix: string,
  cap: number,
  decode: (input: unknown) => Option.Option<A>,
): Table<A> {
  return { prefix, cap, decode, index: new Map(), written: new Map() };
}

const positionKey = (file: FileReadingKey, view: ReadingView) =>
  POSITION_PREFIX + JSON.stringify([file.environmentId, file.absolutePath, view]);
const receiptKey = (threadKey: string, relativePath: string) =>
  RECEIPT_PREFIX + JSON.stringify([threadKey, relativePath]);

export type FileReadingStore = ReturnType<typeof createFileReadingStore>;

export function createFileReadingStore(options: {
  readonly storage: () => StorageLike | null | undefined;
  readonly now: () => number;
}) {
  const positions = table(
    POSITION_PREFIX,
    POSITION_CAP,
    Schema.decodeUnknownOption(ReadingPosition),
  );
  const receipts = table(RECEIPT_PREFIX, RECEIPT_CAP, Schema.decodeUnknownOption(RevealReceipt));
  const tables: ReadonlyArray<Table<unknown>> = [positions, receipts];
  let storage: StorageLike | null | undefined;
  let scanned = false;
  let writable = true;

  const resolveStorage = (): StorageLike | null => {
    if (storage === undefined) {
      try {
        storage = options.storage() ?? null;
      } catch {
        storage = null;
      }
    }
    return storage;
  };
  const fresh = (at: number, now: number) => Math.abs(now - at) < READING_TTL_MS;

  const dropStored = (target: Table<unknown>, key: string) => {
    target.index.delete(key);
    try {
      resolveStorage()?.removeItem(key);
    } catch {
      // Unreadable storage keeps its key; the in-memory index has already dropped it.
    }
  };

  const readStored = <A>(target: Table<A>, key: string, now: number): Entry<A> | undefined => {
    let raw: string | null = null;
    try {
      raw = resolveStorage()?.getItem(key) ?? null;
    } catch {
      return undefined;
    }
    if (raw === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      dropStored(target, key);
      return undefined;
    }
    const header = decodeHeader(json);
    const value = target.decode(json);
    if (Option.isNone(header) || Option.isNone(value) || !fresh(header.value.at, now)) {
      dropStored(target, key);
      return undefined;
    }
    return { at: header.value.at, value: value.value };
  };

  const evict = (target: Table<unknown>, now: number) => {
    for (const [key, at] of target.index) {
      if (target.index.size <= target.cap && fresh(at, now)) break;
      dropStored(target, key);
    }
  };

  const scan = () => {
    if (scanned) return;
    scanned = true;
    const store = resolveStorage();
    if (store === null) return;
    let keys: string[];
    try {
      keys = Array.from({ length: store.length }, (_, index) => store.key(index) ?? "");
    } catch {
      return;
    }
    const now = options.now();
    const found: Array<{ target: Table<unknown>; key: string; at: number }> = [];
    for (const key of keys) {
      const target = tables.find((candidate) => key.startsWith(candidate.prefix));
      if (target === undefined) continue;
      const entry =
        target === receipts && Option.isNone(parseReceiptKey(key))
          ? undefined
          : readStored(target, key, now);
      if (entry === undefined) dropStored(target, key);
      else found.push({ target, key, at: entry.at });
    }
    found.sort((left, right) => left.at - right.at);
    for (const { target, key, at } of found) target.index.set(key, at);
    for (const target of tables) evict(target, now);
  };

  const trySet = (key: string, raw: string) => {
    try {
      resolveStorage()?.setItem(key, raw);
      return true;
    } catch {
      return false;
    }
  };

  const read = <A>(target: Table<A>, key: string): Entry<A> | undefined => {
    scan();
    const now = options.now();
    const written = target.written.get(key);
    const mine = written !== undefined && fresh(written.at, now) ? written : undefined;
    const stored = readStored(target, key, now);
    return stored !== undefined && (mine === undefined || stored.at > mine.at) ? stored : mine;
  };

  const write = <A>(target: Table<A>, key: string, value: A) => {
    scan();
    const at = options.now();
    target.written.delete(key);
    target.written.set(key, { at, value });
    for (const writtenKey of target.written.keys()) {
      if (target.written.size <= target.cap) break;
      target.written.delete(writtenKey);
    }
    if (!writable || resolveStorage() === null) return;
    const raw = JSON.stringify({ v: 1, at, ...value });
    if (!trySet(key, raw)) {
      for (const other of tables) {
        for (const [otherKey, otherAt] of other.index) {
          if (!fresh(otherAt, at)) dropStored(other, otherKey);
        }
      }
      let oldestHalf = Math.ceil(target.index.size / 2);
      for (const oldKey of target.index.keys()) {
        if (oldestHalf-- <= 0) break;
        dropStored(target, oldKey);
      }
      if (!trySet(key, raw)) {
        writable = false;
        return;
      }
    }
    target.index.delete(key);
    target.index.set(key, at);
    evict(target, at);
  };

  return {
    readPosition<V extends ReadingView>(
      file: FileReadingKey,
      view: V,
    ): ReadingPositionOf<V> | null {
      const value = read(positions, positionKey(file, view))?.value;
      return value?.view === view ? (value as ReadingPositionOf<V>) : null;
    },
    writePosition(file: FileReadingKey, position: ReadingPosition): void {
      write(positions, positionKey(file, position.view), position);
    },
    /** The view among `views` whose saved entry is newest. */
    newestView(file: FileReadingKey, views: ReadonlyArray<ReadingView>): ReadingView | null {
      let newest: Entry<ReadingPosition> | undefined;
      for (const view of views) {
        const entry = read(positions, positionKey(file, view));
        if (entry?.value.view === view && (newest === undefined || entry.at > newest.at)) {
          newest = entry;
        }
      }
      return newest?.value.view ?? null;
    },
    readReceipt(threadKey: string, relativePath: string): RevealReceipt | null {
      return read(receipts, receiptKey(threadKey, relativePath))?.value ?? null;
    },
    writeReceipt(threadKey: string, relativePath: string, receipt: RevealReceipt): void {
      write(receipts, receiptKey(threadKey, relativePath), receipt);
    },
    receiptTabs(): ReadonlyArray<{ readonly threadKey: string; readonly relativePath: string }> {
      scan();
      return [...new Set([...receipts.index.keys(), ...receipts.written.keys()])].flatMap((key) =>
        Option.match(parseReceiptKey(key), {
          onNone: () => [],
          onSome: ([threadKey, relativePath]) => [{ threadKey, relativePath }],
        }),
      );
    },
  };
}

function parseReceiptKey(key: string) {
  try {
    return decodeReceiptKey(JSON.parse(key.slice(RECEIPT_PREFIX.length)));
  } catch {
    return Option.none();
  }
}

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;
export type RevealVerdict = "none" | "pending" | "shown";

export function liveFileSurface(
  thread: ThreadRightPanelState | undefined,
  relativePath: string | null,
): FileSurface | undefined {
  if (relativePath === null) return undefined;
  const id = `file:${relativePath}`;
  return thread?.surfaces.find(
    (surface): surface is FileSurface => surface.id === id && surface.kind === "file",
  );
}

/**
 * Whether a tab's line reveal has been shown. In a page load the truth is the surface object:
 * `openFile` always builds a new one. Receipts carry it across reloads for unchanged tabs.
 */
export function createRevealLedger(
  readings: FileReadingStore,
  panel: Pick<typeof useRightPanelStore, "getState" | "subscribe">,
  closedViews: Pick<typeof useClosedViewStore, "subscribe">,
) {
  const shown = new WeakSet<FileSurface>();
  const generations = new WeakMap<FileSurface, number>();
  let lastGeneration = 0;
  let started = false;

  const close = (threadKey: string, relativePath: string) => {
    const receipt = readings.readReceipt(threadKey, relativePath);
    if (receipt !== null && receipt.closed !== true) {
      readings.writeReceipt(threadKey, relativePath, { ...receipt, closed: true });
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    const state = panel.getState();
    for (const { threadKey, relativePath } of readings.receiptTabs()) {
      // A close before this module loaded may have reopened the tab with a recycled request id.
      const surface =
        (state.closeRevisionByThreadKey[threadKey] ?? 0) === 0
          ? liveFileSurface(state.byThreadKey[threadKey], relativePath)
          : undefined;
      const receipt = readings.readReceipt(threadKey, relativePath);
      if (surface === undefined) close(threadKey, relativePath);
      else if (
        receipt?.closed !== true &&
        receipt?.id === surface.revealRequestId &&
        receipt.line === surface.revealLine
      ) {
        shown.add(surface);
      }
    }
    panel.subscribe((next, previous) => {
      if (next.byThreadKey === previous.byThreadKey) return;
      for (const [threadKey, before] of Object.entries(previous.byThreadKey)) {
        const after = next.byThreadKey[threadKey];
        if (after === before) continue;
        for (const surface of before.surfaces) {
          if (surface.kind !== "file" || surface.id !== `file:${surface.relativePath}`) continue;
          if (after?.surfaces.some((entry) => entry.id === surface.id)) continue;
          close(threadKey, surface.relativePath);
        }
      }
    });
    // Reopen Closed View calls `openFile` with the closed tab's line, then removes its entry.
    closedViews.subscribe((next, previous) => {
      if (next.entries.some((entry) => !previous.entries.includes(entry))) return;
      for (const entry of previous.entries) {
        if (next.entries.includes(entry) || entry.kind !== "panel-tab") continue;
        const closed = entry.surface;
        if (closed.kind !== "file" || closed.attachment !== undefined) continue;
        const threadKey = scopedThreadKey(entry.threadRef);
        const live = liveFileSurface(panel.getState().byThreadKey[threadKey], closed.relativePath);
        const receipt = readings.readReceipt(threadKey, closed.relativePath);
        if (
          live === undefined ||
          shown.has(live) ||
          receipt?.closed !== true ||
          live.revealLine !== receipt.line ||
          closed.revealLine !== receipt.line
        ) {
          continue;
        }
        shown.add(live);
        readings.writeReceipt(threadKey, closed.relativePath, {
          id: live.revealRequestId,
          line: receipt.line,
        });
      }
    });
  };

  return {
    /** Adopts receipts and starts forgetting closed tabs; later calls do nothing. */
    start,
    verdict(surface: FileSurface | undefined): RevealVerdict {
      start();
      if (surface === undefined || surface.revealLine === null) return "none";
      return shown.has(surface) ? "shown" : "pending";
    },
    /** A reveal key unique to the surface object, so a recycled request id still reveals. */
    generation(surface: FileSurface | undefined): number {
      if (surface === undefined) return 0;
      let generation = generations.get(surface);
      if (generation === undefined) {
        generation = ++lastGeneration;
        generations.set(surface, generation);
      }
      return generation;
    },
    markShown(threadKey: string, surface: FileSurface): void {
      start();
      shown.add(surface);
      if (surface.revealLine === null) return;
      const live = liveFileSurface(panel.getState().byThreadKey[threadKey], surface.relativePath);
      if (live !== surface) return;
      readings.writeReceipt(threadKey, surface.relativePath, {
        id: surface.revealRequestId,
        line: surface.revealLine,
      });
    },
  };
}
