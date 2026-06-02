import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Queue, Stream } from "effect"

describe("Queue", () => {
  it.effect("isEnqueue type guard", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)

      assert.isTrue(Queue.isEnqueue(queue))
      assert.isFalse(Queue.isEnqueue({}))
      assert.isFalse(Queue.isEnqueue(null))
    }))

  it.effect("isDequeue type guard", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)

      assert.isTrue(Queue.isDequeue(queue))
      assert.isFalse(Queue.isDequeue({}))
      assert.isFalse(Queue.isDequeue(null))
    }))

  it.effect("asEnqueue converts to write-only interface", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)
      const enqueue: Queue.Enqueue<number> = Queue.asEnqueue(queue)

      // Verify it's recognized as an enqueue
      assert.isTrue(Queue.isEnqueue(enqueue))

      // Verify queue operations still work through enqueue reference
      assert.isTrue(Queue.isQueue(enqueue))
    }))

  it.effect("asDequeue converts to read-only interface", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)
      yield* Queue.offer(queue, 42)

      const dequeue = Queue.asDequeue(queue)

      // Can use dequeue operations
      const item = yield* Queue.take(dequeue)
      assert.strictEqual(item, 42)

      // Verify it's recognized as a dequeue
      assert.isTrue(Queue.isDequeue(dequeue))
    }))

  it.effect("bounded offerAll waits until capacity is released", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(2)
      const fiber = yield* Queue.offerAll(queue, [1, 2, 3, 4]).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      assert.isUndefined(fiber.pollUnsafe())

      let result = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(result, [1, 2])

      yield* Effect.yieldNow
      assert.isDefined(fiber.pollUnsafe())

      result = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(result, [3, 4])

      yield* Effect.yieldNow
      assert.deepStrictEqual(fiber.pollUnsafe(), Exit.succeed([]))
    }))

  it.effect("takeN", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<number>()
      yield* Queue.offerAll(queue, [1, 2, 3, 4]).pipe(Effect.forkChild)
      const a = yield* Queue.takeN(queue, 2)
      const b = yield* Queue.takeN(queue, 2)
      assert.deepEqual(a, [1, 2])
      assert.deepEqual(b, [3, 4])
    }))

  it.effect("collect does not duplicate messages", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<{ id: number }, Cause.Done>(10)
      yield* Queue.offer(queue, { id: 0 })
      yield* Queue.end(queue)

      const result = yield* Queue.collect(queue)
      assert.deepStrictEqual(result, [{ id: 0 }])
    }))

  it.effect("offer dropping", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.make<number>({ capacity: 2, strategy: "dropping" })
      const remaining = yield* Queue.offerAll(queue, [1, 2, 3, 4])
      assert.deepStrictEqual(remaining, [3, 4])
      const result = yield* Queue.offer(queue, 5)
      assert.isFalse(result)
      assert.deepStrictEqual(yield* Queue.takeAll(queue), [1, 2])
    }))

  it.effect("offer sliding", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.make<number>({ capacity: 2, strategy: "sliding" })
      const remaining = yield* Queue.offerAll(queue, [1, 2, 3, 4])
      assert.deepStrictEqual(remaining, [])
      const result = yield* Queue.offer(queue, 5)
      assert.isTrue(result)
      assert.deepStrictEqual(yield* Queue.takeAll(queue), [4, 5])
    }))

  it.effect("offerAll can be interrupted", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(2)
      const fiber = yield* Queue.offerAll(queue, [1, 2, 3, 4]).pipe(
        Effect.forkChild
      )

      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      yield* Effect.yieldNow

      let result = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(result, [1, 2])

      yield* Queue.offer(queue, 5)
      yield* Effect.yieldNow

      result = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(result, [5])
    }))

  it.effect("done completes takes", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number, Cause.Done>(2)
      const fiber = yield* Queue.takeAll(queue).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* Queue.end(queue)
      assert.deepStrictEqual(yield* Fiber.await(fiber), Exit.fail(Cause.Done()))
    }))

  it.effect("end", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number, Cause.Done>(2)
      yield* Effect.forkChild(Queue.offerAll(queue, [1, 2, 3, 4]))
      yield* Effect.forkChild(Queue.offerAll(queue, [5, 6, 7, 8]))
      yield* Effect.forkChild(Queue.offer(queue, 9))
      yield* Effect.forkChild(Queue.end(queue))
      const items = yield* Stream.runCollect(Stream.fromQueue(queue))
      assert.deepStrictEqual(items, [1, 2, 3, 4, 5, 6, 7, 8, 9])
      assert.strictEqual(yield* Queue.await(queue), void 0)
      assert.strictEqual(yield* Queue.offer(queue, 10), false)
    }))

  it.effect("end with take", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number, Cause.Done>(2)
      yield* Effect.forkChild(Queue.offerAll(queue, [1, 2]))
      yield* Effect.forkChild(Queue.offer(queue, 3))
      yield* Effect.forkChild(Queue.end(queue))
      assert.strictEqual(yield* Queue.take(queue), 1)
      assert.strictEqual(yield* Queue.take(queue), 2)
      assert.strictEqual(yield* Queue.take(queue), 3)
      assert.strictEqual(Cause.isDone(yield* Queue.take(queue).pipe(Effect.flip)), true)
      assert.strictEqual(yield* Queue.await(queue), void 0)
      assert.strictEqual(yield* Queue.offer(queue, 10), false)
    }))

  it.effect("interrupt allows draining", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)
      yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])

      // Interrupt gracefully
      const interrupted = yield* Queue.interrupt(queue)
      assert.strictEqual(interrupted, true)

      // No more offers accepted
      const offerResult = yield* Queue.offer(queue, 6)
      assert.strictEqual(offerResult, false)

      // But can still drain existing messages
      assert.strictEqual(yield* Queue.take(queue), 1)
      assert.strictEqual(yield* Queue.take(queue), 2)
      assert.strictEqual(yield* Queue.take(queue), 3)
      assert.strictEqual(yield* Queue.take(queue), 4)
      assert.strictEqual(yield* Queue.take(queue), 5)

      // Now queue is done and take fails with interrupt
      const exit = yield* Queue.take(queue).pipe(Effect.exit)
      assert.isTrue(Exit.hasInterrupts(exit))
    }))

  it.effect("poll returns Option for non-blocking take", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)

      // Poll returns Option.none when empty
      const empty = yield* Queue.poll(queue)
      assert.isTrue(Option.isNone(empty))

      // Add an item
      yield* Queue.offer(queue, 42)

      // Poll returns Option.some with the item
      const item = yield* Queue.poll(queue)
      assert.isTrue(Option.isSome(item))
      assert.strictEqual(Option.getOrNull(item), 42)

      // Queue is now empty again
      const empty2 = yield* Queue.poll(queue)
      assert.isTrue(Option.isNone(empty2))
    }))

  it.effect("peek views item without removing it", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(10)
      yield* Queue.offer(queue, 42)

      // Peek at the item
      const item = yield* Queue.peek(queue)
      assert.strictEqual(item, 42)

      // Item is still in the queue
      const size = yield* Queue.size(queue)
      assert.strictEqual(size, 1)

      // Peek again - same item
      const item2 = yield* Queue.peek(queue)
      assert.strictEqual(item2, 42)

      // Now take it
      const taken = yield* Queue.take(queue)
      assert.strictEqual(taken, 42)

      // Queue is now empty
      const newSize = yield* Queue.size(queue)
      assert.strictEqual(newSize, 0)
    }))

  it.effect("fail drains buffered values before failing takers", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number, string>(2)
      yield* Effect.forkChild(Queue.offerAll(queue, [1, 2, 3, 4]))
      yield* Effect.forkChild(Queue.offer(queue, 5))
      yield* Effect.forkChild(Queue.fail(queue, "boom"))
      const takeArr = Queue.takeAll(queue)
      assert.deepStrictEqual(yield* takeArr, [1, 2])
      assert.deepStrictEqual(yield* takeArr, [3, 4])
      const items = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(items, [5])
      const error = yield* Queue.takeAll(queue).pipe(Effect.flip)
      assert.deepStrictEqual(error, "boom")
      assert.strictEqual(yield* Queue.await(queue).pipe(Effect.flip), "boom")
      assert.strictEqual(yield* Queue.offer(queue, 6), false)
    }))

  it.effect("shutdown", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(2)
      yield* Effect.forkChild(Queue.offerAll(queue, [1, 2, 3, 4]))
      yield* Effect.forkChild(Queue.offerAll(queue, [5, 6, 7, 8]))
      yield* Effect.forkChild(Queue.shutdown(queue))
      const exit = yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(
        Effect.exit
      )
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(Queue.await(queue))))
      assert.strictEqual(yield* Queue.offer(queue, 10), false)
    }))

  it.effect("fail doesnt drop items", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number, string>(2)
      yield* Effect.forkChild(Queue.offerAll(queue, [1, 2, 3, 4]))
      yield* Effect.forkChild(Queue.offer(queue, 5))
      yield* Effect.forkChild(Queue.fail(queue, "boom"))
      const items: Array<number> = []
      const error = yield* Stream.fromQueue(queue).pipe(
        Stream.runForEach((item) => Effect.sync(() => items.push(item))),
        Effect.flip
      )
      assert.deepStrictEqual(items, [1, 2, 3, 4, 5])
      assert.strictEqual(error, "boom")
    }))

  it.effect("await waits for no items", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<number, Cause.Done>()
      const fiber = yield* Queue.await(queue).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Queue.offer(queue, 1)
      yield* Queue.end(queue)

      yield* Effect.yieldNow
      assert.isUndefined(fiber.pollUnsafe())
      const result = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(result, [1])
      yield* Effect.flip(Queue.takeAll(queue))
      yield* Effect.yieldNow
      assert.isNotNull(fiber.pollUnsafe())
    }))

  it.effect("bounded 0 capacity", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<number>(0)
      yield* Queue.offer(queue, 1).pipe(Effect.forkChild)
      let result = yield* Queue.take(queue)
      assert.strictEqual(result, 1)
      const fiber = yield* Queue.take(queue).pipe(Effect.forkChild)
      yield* Queue.offer(queue, 2)
      result = yield* Fiber.join(fiber)
      assert.strictEqual(result, 2)
    }))
})
