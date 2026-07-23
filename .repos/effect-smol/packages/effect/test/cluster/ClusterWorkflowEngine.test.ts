import { assert, describe, expect, it } from "@effect/vitest"
import { Cause, Context, DateTime, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  ClusterSchema,
  ClusterWorkflowEngine,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig
} from "effect/unstable/cluster"
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow"
import { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine"

describe.concurrent("ClusterWorkflowEngine", () => {
  it.effect("executes, resumes, deduplicates, and polls a suspended workflow", () =>
    Effect.gen(function*() {
      const sharding = yield* Sharding.Sharding
      const driver = yield* MessageStorage.MemoryDriver
      const flags = yield* Flags

      const fiber = yield* EmailWorkflow.execute({
        id: "test-email-1",
        to: "bob@example.com"
      }).pipe(Effect.forkChild({ startImmediately: true }))

      // resume after the clock
      yield* TestClock.adjust("10 seconds")
      yield* sharding.pollStorage
      yield* TestClock.adjust(5000)

      // --- the workflow is suspended at this point

      // - 1 initial request
      // - 5 attempts to send email
      // - 1 sleep activity
      // - 1 durable clock run
      // - 1 durable clock deferred set
      expect(driver.requests.size).toEqual(9)
      const executionId = driver.journal[0].address.entityId

      // normal finalizer should run even after suspension
      expect(flags.get("finalizer")).toBeTruthy()
      // but not compensation
      expect(flags.get("compensation")).toBeFalsy()
      // ensuring will run
      expect(flags.get("ensuring")).toBeTruthy()
      expect(flags.get("catchCause")).toBeFalsy()

      // --- resume the workflow using DurableDeferred.done

      const token = yield* DurableDeferred.token(EmailTrigger).pipe(
        Effect.provideService(WorkflowInstance, WorkflowInstance.initial(EmailWorkflow, executionId))
      )
      yield* DurableDeferred.done(EmailTrigger, {
        token,
        exit: Exit.succeed("done")
      })
      yield* sharding.pollStorage

      // - 1 DurableDeferred set
      expect(driver.requests.size).toEqual(10)

      // allow suspend polling to complete
      yield* TestClock.adjust(10000)
      expect(yield* Fiber.join(fiber)).toBeUndefined()

      // --- the workflow is complete

      // ensuring will run
      expect(flags.get("ensuring")).toBeTruthy()
      expect(flags.get("catchCause")).toBeFalsy()

      // test deduplication
      yield* EmailWorkflow.execute({
        id: "test-email-1",
        to: "bob@example.com"
      })
      expect(driver.requests.size).toEqual(10)

      // test poll
      expect(yield* EmailWorkflow.poll(executionId)).toEqual(Option.some(new Workflow.Complete({ exit: Exit.void })))
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("interrupts a suspended workflow and runs compensation", () =>
    Effect.gen(function*() {
      const sharding = yield* Sharding.Sharding
      const driver = yield* MessageStorage.MemoryDriver
      yield* TestClock.adjust(1)

      const fiber = yield* EmailWorkflow.execute({
        id: "test-email-2",
        to: "bob@example.com"
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(1)
      yield* TestClock.adjust("10 seconds")
      yield* sharding.pollStorage
      yield* TestClock.adjust(1)

      const envelope = driver.journal[0]
      const executionId = envelope.address.entityId
      yield* EmailWorkflow.interrupt(executionId)

      // - 1 initial request
      // - 5 attempts to send email
      // - 1 sleep activity
      // - 1 durable clock run
      // - 1 durable clock deferred set
      // - 1 interrupt signal set
      expect(driver.requests.size).toEqual(10)
      yield* TestClock.adjust(5000)
      yield* sharding.pollStorage
      yield* TestClock.adjust(5000)
      // - clock cleared
      expect(driver.requests.size).toEqual(9)

      const result = driver.requests.get(envelope.requestId)!
      const reply = result.replies[0]!
      assert(
        reply._tag === "WithExit" &&
          reply.exit._tag === "Success"
      )
      const value = reply.exit.value as Workflow.ResultEncoded<any, any>
      assert(value._tag === "Complete" && value.exit._tag === "Failure")

      const exit = yield* Fiber.await(fiber)
      assert(Exit.hasInterrupts(exit))

      const flags = yield* Flags
      assert.isTrue(flags.get("compensation"))
    }).pipe(
      Effect.provide(TestWorkflowLayer)
    ))

  it.effect("Workflow.withCompensation runs compensation when the workflow fails", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)

      const fiber = yield* EmailWorkflow.execute({
        id: "test-email-3",
        to: "compensation"
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(500)

      const flags = yield* Flags
      assert.isTrue(flags.get("compensation"))

      const error = yield* Fiber.join(fiber).pipe(
        Effect.flip
      )
      expect(error).toBeInstanceOf(SendEmailError)
    }).pipe(
      Effect.provide(TestWorkflowLayer)
    ))

  it.effect("Activity.raceAll returns the first activity and interrupts losers", () =>
    Effect.gen(function*() {
      const flags = yield* Flags
      yield* TestClock.adjust(1)

      const fiber = yield* RaceWorkflow.execute({
        id: "race-1"
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(500)

      const result = yield* Fiber.join(fiber)
      expect(result).toEqual("Activity3")

      expect(flags.get("interrupt1")).toBeTruthy()
      expect(flags.get("interrupt2")).toBeTruthy()
      expect(flags.get("interrupt3")).toBeFalsy()
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("Activity.raceAll resumes the first durable activity", () =>
    Effect.gen(function*() {
      const sharding = yield* Sharding.Sharding
      yield* TestClock.adjust(1)

      const fiber = yield* DurableRaceWorkflow.execute({
        id: "race-2"
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(1)
      yield* TestClock.adjust(1000)
      yield* sharding.pollStorage
      yield* TestClock.adjust(5000)

      const result = yield* Fiber.join(fiber)
      expect(result).toEqual("Activity3")
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("nested workflows", () =>
    Effect.gen(function*() {
      const flags = yield* Flags
      const sharding = yield* Sharding.Sharding
      yield* TestClock.adjust(1)

      yield* ParentWorkflow.execute({
        id: "123"
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(1000)

      assert.isUndefined(flags.get("parent-end"))
      assert.isUndefined(flags.get("child-end"))
      assert.isTrue(flags.get("parent-suspended"))
      const token = flags.get("child-token")
      assert(typeof token === "string")

      yield* DurableDeferred.done(ChildDeferred, {
        token: DurableDeferred.Token.make(token),
        exit: Exit.void
      })
      yield* TestClock.adjust(5000)
      yield* sharding.pollStorage
      assert.isTrue(flags.get("parent-end"))
      assert.isTrue(flags.get("child-end"))
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("routes durable clock wakeups to the workflow shard group", () =>
    Effect.gen(function*() {
      const driver = yield* MessageStorage.MemoryDriver
      const sharding = yield* Sharding.Sharding

      const fiber = yield* ShardedClockWorkflow.execute({
        id: "sharded-clock"
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(1)

      const envelope = driver.journal.find((envelope) =>
        envelope._tag === "Request" && envelope.address.entityType === "Workflow/-/DurableClock"
      )
      assert(envelope)
      assert.strictEqual(envelope.address.shardId.group, "workflow")

      yield* TestClock.adjust("10 seconds")
      yield* sharding.pollStorage
      yield* TestClock.adjust(5000)
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("routes durable deferred completions to the workflow shard group after a partial client is cached", () =>
    Effect.gen(function*() {
      const driver = yield* MessageStorage.MemoryDriver
      const engine = yield* WorkflowEngine
      const executionIdBeforeRegister = yield* ShardedDeferredWorkflow.executionId({ id: "before-register" })
      const tokenBeforeRegister = DurableDeferred.tokenFromExecutionId(ShardedDeferred, {
        workflow: ShardedDeferredWorkflow,
        executionId: executionIdBeforeRegister
      })

      yield* DurableDeferred.done(ShardedDeferred, {
        token: tokenBeforeRegister,
        exit: Exit.void
      })

      yield* engine.register(ShardedDeferredWorkflow, () => Effect.void)

      const executionIdAfterRegister = yield* ShardedDeferredWorkflow.executionId({ id: "after-register" })
      const tokenAfterRegister = DurableDeferred.tokenFromExecutionId(ShardedDeferred, {
        workflow: ShardedDeferredWorkflow,
        executionId: executionIdAfterRegister
      })
      const journalLength = driver.journal.length
      yield* DurableDeferred.done(ShardedDeferred, {
        token: tokenAfterRegister,
        exit: Exit.void
      })

      const envelope = driver.journal.slice(journalLength).find((envelope) =>
        envelope._tag === "Request" && envelope.address.entityType === "Workflow/ShardedDeferredWorkflow"
      )
      assert(envelope)
      assert.strictEqual(envelope.address.shardId.group, "workflow")
    }).pipe(Effect.scoped, Effect.provide(TestWorkflowEngine)))

  it.effect("SuspendOnFailure", () =>
    Effect.gen(function*() {
      const flags = yield* Flags
      yield* TestClock.adjust(1)

      yield* SuspendOnFailureWorkflow.execute({
        id: ""
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(2000)

      assert.isTrue(flags.get("suspended"))
      assert.include(flags.get("cause"), "boom")
    }).pipe(Effect.provide(TestWorkflowLayer)))

  it.effect("catchCause activity", () =>
    Effect.gen(function*() {
      const flags = yield* Flags
      yield* TestClock.adjust(1)

      const fiber = yield* CatchWorkflow.execute({
        id: ""
      }).pipe(Effect.forkScoped)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)

      assert.isTrue(flags.get("catch"))
    }).pipe(Effect.provide(TestWorkflowLayer)))
})

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  availableShardGroups: ["default", "workflow"],
  assignedShardGroups: ["default", "workflow"],
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100
})

const TestWorkflowEngine = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(Sharding.layer),
  Layer.provide(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide(RunnerStorage.layerMemory),
  Layer.provide(RunnerHealth.layerNoop),
  Layer.provide(TestShardingConfig)
)

class SendEmailError extends Schema.ErrorClass<SendEmailError>("SendEmailError")({
  _tag: Schema.tag("SendEmailError"),
  message: Schema.String
}) {}

const EmailWorkflow = Workflow.make({
  name: "EmailWorkflow",
  payload: {
    to: Schema.String,
    id: Schema.String
  },
  error: SendEmailError,
  idempotencyKey(payload) {
    return payload.id
  }
})

class Flags extends Context.Service<Flags>()("Flags", {
  make: Effect.sync(() => new Map<string, boolean | string>())
}) {
  static readonly layer = Layer.effect(Flags, this.make)
}

const EmailWorkflowLayer = EmailWorkflow.toLayer(Effect.fn(function*(payload) {
  const flags = yield* Flags

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      flags.set("finalizer", true)
    })
  )

  yield* Activity.make({
    name: "SendEmail",
    error: SendEmailError,
    execute: Effect.gen(function*() {
      const attempt = yield* Activity.CurrentAttempt

      if (attempt !== 5) {
        return yield* new SendEmailError({
          message: `Failed to send email for ${payload.id} on attempt ${attempt}`
        })
      }
    })
  }).pipe(
    EmailWorkflow.withCompensation(Effect.fnUntraced(function*() {
      flags.set("compensation", true)
    })),
    Activity.retry({ times: 5 })
  )

  if (payload.to === "compensation") {
    return yield* new SendEmailError({ message: `Compensation triggered` })
  }

  const result = yield* Activity.make({
    name: "Sleep",
    success: Schema.DateTimeUtc,
    execute: Effect.gen(function*() {
      // suspended inside Activity
      yield* DurableClock.sleep({
        name: "Some sleep",
        duration: "10 seconds",
        inMemoryThreshold: Duration.zero
      })
      return yield* DateTime.now
    })
  })
  // test serialization from Activity
  assert(DateTime.isUtc(result))

  yield* DurableDeferred.token(EmailTrigger)
  // suspended outside Activity
  yield* DurableDeferred.await(EmailTrigger).pipe(
    Effect.catchCause(() => {
      flags.set("catchCause", true)
      return Effect.void
    }),
    Effect.ensuring(Effect.sync(() => {
      flags.set("ensuring", true)
    }))
  )
})).pipe(
  Layer.provideMerge(Flags.layer)
)

const EmailTrigger = DurableDeferred.make("EmailTrigger", {
  success: Schema.String
})

const RaceWorkflow = Workflow.make({
  name: "RaceWorkflow",
  payload: {
    id: Schema.String
  },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const RaceWorkflowLayer = RaceWorkflow.toLayer(Effect.fnUntraced(function*() {
  const flags = yield* Flags

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      flags.set("finalizer", true)
    })
  )

  return yield* Activity.raceAll("race", [
    Activity.make({
      name: "Activity1",
      success: Schema.String,
      error: Schema.Never,
      execute: Effect.onInterrupt(Effect.delay(Effect.succeed("Activity1"), 1000), () =>
        Effect.sync(() => {
          flags.set("interrupt1", true)
        }))
    }),
    Activity.make({
      name: "Activity2",
      success: Schema.String,
      error: Schema.Never,
      execute: Effect.onInterrupt(Effect.delay(Effect.succeed("Activity2"), 500), () =>
        Effect.sync(() => {
          flags.set("interrupt2", true)
        }))
    }),
    Activity.make({
      name: "Activity3",
      success: Schema.String,
      error: Schema.Never,
      execute: Effect.onInterrupt(Effect.delay(Effect.succeed("Activity3"), 100), () =>
        Effect.sync(() => {
          flags.set("interrupt3", true)
        }))
    })
  ])
}))

const DurableRaceWorkflow = Workflow.make({
  name: "DurableRaceWorkflow",
  payload: {
    id: Schema.String
  },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const DurableRaceWorkflowLayer = DurableRaceWorkflow.toLayer(Effect.fnUntraced(function*() {
  const flags = yield* Flags

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      flags.set("finalizer", true)
    })
  )

  return yield* Activity.raceAll("race", [
    Activity.make({
      name: "Activity1",
      success: Schema.String,
      error: Schema.Never,
      execute: DurableClock.sleep({
        name: "Activity1",
        duration: 50000,
        inMemoryThreshold: Duration.zero
      }).pipe(
        Effect.as("Activity1")
      )
    }),
    Activity.make({
      name: "Activity2",
      success: Schema.String,
      error: Schema.Never,
      execute: DurableClock.sleep({
        name: "Activity2",
        duration: 10000,
        inMemoryThreshold: Duration.zero
      }).pipe(
        Effect.as("Activity2")
      )
    }),
    Activity.make({
      name: "Activity3",
      success: Schema.String,
      error: Schema.Never,
      execute: DurableClock.sleep({
        name: "Activity3",
        duration: 1000,
        inMemoryThreshold: Duration.zero
      }).pipe(
        Effect.as("Activity3")
      )
    })
  ])
}))

const ParentWorkflow = Workflow.make({
  name: "ParentWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
})

const ChildWorkflow = Workflow.make({
  name: "ChildWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
})

const ParentWorkflowLayer = ParentWorkflow.toLayer(Effect.fnUntraced(function*({ id }) {
  const flags = yield* Flags
  const instance = yield* WorkflowInstance
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      flags.set("parent-suspended", instance.suspended)
    })
  )
  yield* ChildWorkflow.execute({ id })
  flags.set("parent-end", true)
}))

const ChildDeferred = DurableDeferred.make("ChildDeferred")
const ChildWorkflowLayer = ChildWorkflow.toLayer(Effect.fnUntraced(function*() {
  const flags = yield* Flags
  flags.set("child-token", yield* DurableDeferred.token(ChildDeferred))
  yield* DurableDeferred.await(ChildDeferred)
  flags.set("child-end", true)
}))

const ShardedClockWorkflow = Workflow.make({
  name: "ShardedClockWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
}).annotate(ClusterSchema.ShardGroup, () => "workflow")

const ShardedClockWorkflowLayer = ShardedClockWorkflow.toLayer(Effect.fnUntraced(function*() {
  yield* DurableClock.sleep({
    name: "ShardedClock",
    duration: "10 seconds",
    inMemoryThreshold: Duration.zero
  })
}))

const ShardedDeferred = DurableDeferred.make("ShardedDeferred")

const ShardedDeferredWorkflow = Workflow.make({
  name: "ShardedDeferredWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
}).annotate(ClusterSchema.ShardGroup, () => "workflow")

const SuspendOnFailureWorkflow = Workflow.make({
  name: "SuspendOnFailureWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
}).annotate(Workflow.SuspendOnFailure, true)

const SuspendOnFailureWorkflowLayer = SuspendOnFailureWorkflow.toLayer(Effect.fnUntraced(function*() {
  const flags = yield* Flags
  const instance = yield* WorkflowInstance
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      flags.set("suspended", instance.suspended)
      flags.set("cause", Cause.pretty(instance.cause!))
    })
  )
  yield* Activity.make({
    name: "fail",
    execute: Effect.die("boom")
  })
}))

const CatchWorkflow = Workflow.make({
  name: "CatchWorkflow",
  payload: {
    id: Schema.String
  },
  idempotencyKey(payload) {
    return payload.id
  }
})

const CatchWorkflowLayer = CatchWorkflow.toLayer(Effect.fnUntraced(function*() {
  const flags = yield* Flags
  yield* Activity.make({
    name: "fail",
    execute: Effect.die("boom")
  }).pipe(
    Effect.catchCause((cause) =>
      Activity.make({
        name: "log",
        execute: Effect.suspend(() => {
          flags.set("catch", true)
          return Effect.log(cause)
        })
      })
    )
  )
}))

const TestWorkflowLayer = EmailWorkflowLayer.pipe(
  Layer.merge(RaceWorkflowLayer),
  Layer.merge(DurableRaceWorkflowLayer),
  Layer.merge(ParentWorkflowLayer),
  Layer.merge(ChildWorkflowLayer),
  Layer.merge(ShardedClockWorkflowLayer),
  Layer.merge(SuspendOnFailureWorkflowLayer),
  Layer.merge(CatchWorkflowLayer),
  Layer.provideMerge(Flags.layer),
  Layer.provideMerge(TestWorkflowEngine)
)
