// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import Heap from "heap-js";
import type { InstanceMetadata, WakerPriorityEntry, WakerPriorityType } from "../instance.ts";

const wakerPriorityEntryComparator = (a: WakerPriorityEntry, b: WakerPriorityEntry) => {
  return a.targetTimestamp - b.targetTimestamp;
};

const enum SQLiteBoolean {
  FALSE = 0,
  TRUE = 1,
}

const enum EntryType {
  RETRY = 0,
  SLEEP = 1,
  TIMEOUT = 2,
}

type PriorityQueueDBEntry = {
  id: number;
  created_on: string;
  target_timestamp: number;
  action: SQLiteBoolean;
  entryType: number;
  hash: string;
};

export class TimePriorityQueue {
  #heap: Heap<WakerPriorityEntry> = new Heap(wakerPriorityEntryComparator);
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _instanceMetadata: InstanceMetadata) {
    this.#ctx = ctx;

    this.#heap.init(this.getEntries());
  }

  popPastEntries(): Array<WakerPriorityEntry> | undefined {
    // early return if there is nothing in the queue
    if (this.#heap.length === 0) {
      return;
    }
    const res: Array<WakerPriorityEntry> = [];
    const currentTimestamp = new Date().valueOf();
    // heap-js does not have a ordered iterator that doesn't consume the input so we
    // peek the first one, and pop if it's old until it's empty or in the future
    while (true) {
      const element = this.#heap.peek();
      if (element === undefined) {
        break;
      }
      if (element.targetTimestamp > currentTimestamp) {
        break;
      }
      // at this point, targetTimestamp is older so we can pop this node because it's no
      // longer relevant
      res.push(element);
      this.#heap.pop();
    }
    this.#ctx.storage.transactionSync(() => {
      for (const entry of res) {
        this.removeEntryDB(entry);
      }
    });
    return res;
  }

  /**
   * `add` is ran using a transaction so it's race condition free, if it's ran atomically
   * @param entry
   */
  async add(entry: WakerPriorityEntry) {
    await this.#ctx.storage.transaction(async () => {
      // TODO: Handle this
      // const waker = this.#env.WAKERS.idFromName(
      // 	this.#instanceMetadata.instance.id
      // );
      // const wakerStub = this.#env.WAKERS.get(waker);
      // We can optimise this by only calling it if time is sooner than any other
      // await wakerStub.wake(
      // 	new Date(entry.targetTimestamp),
      // 	this.#instanceMetadata
      // );

      this.#heap.add(entry);
      this.addEntryDB(entry);
    });
  }

  /**
   * `remove` is ran using a transaction so it's race condition free, if it's ran atomically
   * @param entry
   */
  remove(entry: Omit<WakerPriorityEntry, "targetTimestamp">) {
    this.#ctx.storage.transactionSync(() => {
      this.removeFirst((e) => {
        if (e.hash === entry.hash && e.type === entry.type) {
          return true;
        }
        return false;
      });
    });
  }

  offsetAll(offset: number) {
    // Clear the entire PQ table and re-insert only the offset entries.
    // We can't use the append-only add/remove pattern here because the
    // UNIQUE (action, entryType, hash) constraint would conflict with
    // the original action=1 rows still in the table.
    this.#ctx.storage.transactionSync(() => {
      const entries = this.#heap.toArray();

      // Wipe the table — removes all historical add/remove rows
      this.#ctx.storage.sql.exec("DELETE FROM priority_queue");

      const newEntries = entries.map((value) => ({
        ...value,
        targetTimestamp: value.targetTimestamp + offset,
      }));
      for (const entry of newEntries) {
        this.addEntryDB(entry);
      }
      // re-init in-memory heap
      this.#heap = new Heap(wakerPriorityEntryComparator);
      this.#heap.init(newEntries);
    });
  }

  popTypeAll(entryType: WakerPriorityType) {
    this.#ctx.storage.transactionSync(() => {
      this.filter((e) => e.type !== entryType);
    });
  }

  // Idempotent, perhaps name should suggest so
  async handleNextAlarm() {
    const nextWakeCall = this.#heap.peek();
    if (nextWakeCall === undefined) {
      return;
    }
    // TODO: Handle this
    // const waker = this.#env.WAKERS.idFromName(
    // 	this.#instanceMetadata.instance.id
    // );
    // const wakerStub = this.#env.WAKERS.get(waker);
    // await wakerStub.wake(
    // 	new Date(nextWakeCall.targetTimestamp),
    // 	this.#instanceMetadata
    // );
  }

  getFirst(callbackFn: (a: WakerPriorityEntry) => boolean): WakerPriorityEntry | undefined {
    // clone it so that people cant just modify the entry on the PQ
    return structuredClone(this.#heap.toArray().find(callbackFn));
  }

  private removeFirst(callbackFn: (a: WakerPriorityEntry) => boolean) {
    const elements = this.#heap.toArray();
    const index = elements.findIndex(callbackFn);
    if (index === -1) {
      return;
    }

    const removedEntry = elements.splice(index, 1)[0];
    this.removeEntryDB(removedEntry);

    this.#heap = new Heap(wakerPriorityEntryComparator);
    this.#heap.init(elements);
  }

  private filter(callbackFn: (a: WakerPriorityEntry) => boolean) {
    const filteredElements = this.#heap.toArray().filter(callbackFn);
    const removedElements = this.#heap.toArray().filter((a) => !callbackFn(a));
    this.#ctx.storage.transactionSync(() => {
      for (const entry of removedElements) {
        this.removeEntryDB(entry);
      }
    });
    this.#heap = new Heap(wakerPriorityEntryComparator);
    this.#heap.init(filteredElements);
  }

  length() {
    return this.#heap.length;
  }

  private getEntries() {
    const entries = [
      ...this.#ctx.storage.sql.exec("SELECT * FROM priority_queue ORDER BY id"),
    ] as Array<PriorityQueueDBEntry>;

    const activeEntries: Array<WakerPriorityEntry> = [];

    entries.forEach((val) => {
      const entryType = toWakerPriorityType(val.entryType);
      // 0 - removed
      if (val.action == 0) {
        const index = activeEntries.findIndex(
          (activeVal) => val.hash == activeVal.hash && entryType == activeVal.type,
        );
        // if it's found remove it from the active list
        if (index !== -1) {
          activeEntries.splice(index, 1);
        }
      } else {
        // 1 - added
        const index = activeEntries.findIndex(
          (activeVal) => val.hash == activeVal.hash && entryType == activeVal.type,
        );
        // if it's found remove it from the active list
        if (index === -1) {
          activeEntries.push({
            hash: val.hash,
            targetTimestamp: val.target_timestamp,
            type: entryType,
          });
        }
      }
    });
    return activeEntries;
  }

  private removeEntryDB(entry: WakerPriorityEntry) {
    this.#ctx.storage.sql.exec(
      `
			INSERT INTO priority_queue (target_timestamp, action, entryType, hash)
			VALUES (?, ?, ? ,?)
			`,
      entry.targetTimestamp,
      SQLiteBoolean.FALSE,
      fromWakerPriorityType(entry.type),
      entry.hash,
    );
  }

  checkIfExistedInPast(entry: Omit<WakerPriorityEntry, "targetTimestamp">) {
    return (
      this.#ctx.storage.sql
        .exec(
          "SELECT * FROM priority_queue WHERE entryType = ? AND hash = ? AND action = ?",
          fromWakerPriorityType(entry.type),
          entry.hash,
          0,
        )
        .toArray().length >= 1
    );
  }

  private addEntryDB(entry: WakerPriorityEntry) {
    this.#ctx.storage.sql.exec(
      `
			INSERT INTO priority_queue (target_timestamp, action, entryType, hash)
			VALUES (?, ?, ? ,?)
			`,
      entry.targetTimestamp,
      SQLiteBoolean.TRUE,
      fromWakerPriorityType(entry.type),
      entry.hash,
    );
  }
}

const toWakerPriorityType = (entryType: EntryType): WakerPriorityType => {
  switch (entryType) {
    case EntryType.RETRY:
      return "retry";
    case EntryType.SLEEP:
      return "sleep";
    case EntryType.TIMEOUT:
      return "timeout";
  }
};

const fromWakerPriorityType = (entryType: WakerPriorityType): EntryType => {
  switch (entryType) {
    case "retry":
      return EntryType.RETRY;
    case "sleep":
      return EntryType.SLEEP;
    case "timeout":
      return EntryType.TIMEOUT;
    default:
      throw new Error(`WakerPriorityType "${entryType}" has not been handled`);
  }
};
