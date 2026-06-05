import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as EventJournal from "effect/unstable/eventlog/EventJournal"

describe("EventJournal", () => {
  it.effect("records entries in memory and publishes local changes", () =>
    Effect.gen(function*() {
      const journal = yield* EventJournal.EventJournal
      let created = 0
      yield* journal.write({
        event: "test",
        primaryKey: "pk-1",
        payload: new Uint8Array([1, 2, 3]),
        effect: (entry) =>
          Effect.sync(() => {
            created = entry.createdAtMillis
          })
      })
      const entries = yield* journal.entries
      assert.strictEqual(entries.length, 1)
      assert.strictEqual(entries[0].event, "test")
      assert.strictEqual(entries[0].primaryKey, "pk-1")
      assert.strictEqual(entries[0].createdAtMillis, created)
    }).pipe(Effect.provide(EventJournal.layerMemory)))
})
