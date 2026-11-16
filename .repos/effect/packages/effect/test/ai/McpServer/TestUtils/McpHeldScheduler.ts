import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scheduler from "effect/Scheduler"

// Holds the dispatcher McpServer creates for registration-time list changes
// until `release`, which runs its pending tasks and waits for them. `describe`
// reports the hold's state for diagnosing hangs (EFF-3277).
export const makeHeldServerScheduler = Effect.gen(function*() {
  const flushed = yield* Deferred.make<void>()
  const held: Array<() => void> = []
  let released = false
  const counts = { serverDispatchers: 0, scheduled: 0, ran: 0 }
  const missedCallers: Array<string> = []
  const describe = () =>
    JSON.stringify({
      released,
      held: held.length,
      ...counts,
      flushed: Deferred.isDoneUnsafe(flushed),
      missedCallers
    })
  const base = new Scheduler.MixedScheduler()
  const late = new Scheduler.MixedScheduler("async", (f) => {
    if (released) {
      const timer = setTimeout(f, 0)
      return () => clearTimeout(timer)
    }
    held.push(f)
    return () => {
      const index = held.indexOf(f)
      if (index !== -1) held.splice(index, 1)
    }
  })
  const scheduler: Scheduler.Scheduler = {
    executionMode: base.executionMode,
    shouldYield: (fiber) => base.shouldYield(fiber),
    makeDispatcher() {
      // Fiber dispatchers are created by the fiber runtime; only McpServer
      // calls `makeDispatcher` directly.
      const stack = new Error().stack ?? ""
      const caller = stack.split("\n")[2] ?? ""
      if (!caller.includes("McpServer.ts")) {
        // Fiber dispatchers created while McpServer is on the stack are expected.
        if (stack.includes("McpServer.ts") && !stack.includes("currentDispatcher") && missedCallers.length < 3) {
          missedCallers.push(stack)
        }
        return base.makeDispatcher()
      }
      counts.serverDispatchers++
      const dispatcher = late.makeDispatcher()
      return {
        scheduleTask: (task, priority) => {
          counts.scheduled++
          return dispatcher.scheduleTask(() => {
            counts.ran++
            task()
            Deferred.doneUnsafe(flushed, Exit.void)
          }, priority)
        },
        flush: () => dispatcher.flush()
      }
    }
  }
  const release = Effect.sync(() => {
    released = true
    for (const f of held.splice(0)) setTimeout(f, 0)
  }).pipe(Effect.andThen(Deferred.await(flushed)))
  return { scheduler, release, describe }
})
