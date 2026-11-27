import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import type { DurableObjectProgramState } from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import { makeClusterSingletonProgram } from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import { inertClusterHandle, makeClusterHandle } from "@effect/platform-cloudflare/internal/alchemyCluster"
import { assert, describe, it } from "@effect/vitest"
import { Context, Cron, Effect, Exit, Fiber } from "effect"
import { ClusterCron, Singleton } from "effect/cluster"
import { Sharding } from "effect/cluster/Sharding"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import { SqliteStorage } from "./fixtures/sqliteStorage.ts"

const retryableError = (message: string) => Object.assign(new Error(message), { retryable: true })

const unusedNamespace = { getByName: () => undefined }

const makeHandle = (layer: Parameters<typeof makeClusterHandle>[0]["layer"], singletonNamespace: object) =>
  makeClusterHandle({
    entities: [],
    layer,
    env: {
      ClusterEntity: unusedNamespace,
      ClusterWorkflow: unusedNamespace,
      ClusterDurableQueue: unusedNamespace,
      ClusterSingleton: singletonNamespace
    }
  })

// Advances the TestClock until the effect completes, so retry backoff runs
// without real waiting.
const withTestClock = Effect.fnUntraced(function*<A, E>(effect: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkChild(effect)
  for (let index = 0; index < 1000 && fiber.pollUnsafe() === undefined; index++) {
    yield* TestClock.adjust("1 minute")
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  return yield* Fiber.join(fiber)
})

// The public `AlchemyCloudflareCluster.make` wires these handles to alchemy's
// Durable Object declarations. The handle tests below run without alchemy; the
// example stack test loads the alchemy-importing glue against this workspace's
// `effect`.
describe("AlchemyCloudflareCluster", () => {
  // Loads the full module graph of the example stack (alchemy, the Cloudflare
  // provider, and this package's alchemy glue) without credentials. It fails
  // when the pinned alchemy release imports a module this `effect` lacks. The
  // URL import keeps alchemy's types out of the tests project. The import
  // blocks the event loop for seconds, so it runs alone rather than alongside
  // the timer-driven tests below.
  it("loads the example alchemy stack", { timeout: 60_000, concurrent: false }, async () => {
    const stack = await import(
      /* @vite-ignore */ new URL("../examples/alchemy/alchemy.run.ts", import.meta.url).href
    )
    assert.isDefined(stack.default)
  })

  it.effect("builds the cluster context from the namespace bindings", () =>
    Effect.gen(function*() {
      const getByNameCalls: Array<string> = []
      const wakeCalls: Array<string> = []
      const fakeNamespace = {
        getByName: (name: string) => {
          getByNameCalls.push(name)
          return {
            wake: () => {
              wakeCalls.push(name)
              return Promise.resolve()
            }
          }
        }
      }

      const entityNamespace = { getByName: () => undefined }
      const workflowNamespace = { getByName: () => undefined }
      const queueNamespace = { getByName: () => undefined }
      const cluster = yield* makeClusterHandle({
        entities: [],
        layer: Singleton.make("maintenance", Effect.void),
        env: {
          ClusterEntity: entityNamespace,
          ClusterWorkflow: workflowNamespace,
          ClusterDurableQueue: queueNamespace,
          ClusterSingleton: fakeNamespace
        }
      })

      // The singleton registration fail-fast resolved its object eagerly.
      assert.include(getByNameCalls, "Singleton/maintenance")

      // The built context carries the cluster services and backs `provide`.
      assert.isTrue(Context.getOption(cluster.context, Sharding)._tag === "Some")
      assert.strictEqual(cluster.entityNamespace, entityNamespace as any)
      assert.strictEqual(cluster.workflowNamespace, workflowNamespace as any)
      assert.strictEqual(cluster.queueNamespace, queueNamespace as any)
      assert.strictEqual(cluster.singletonNamespace, fakeNamespace as any)
      assert.strictEqual(yield* cluster.provide(Effect.succeed("ok")), "ok")

      // `wake` resolves the singleton object lazily and calls its wake().
      const wake = cluster.wake("maintenance")
      assert.deepStrictEqual(wakeCalls, [])
      yield* wake()
      assert.deepStrictEqual(wakeCalls, ["Singleton/maintenance"])
    }))

  it.effect("retries a wake that failed in transit on a fresh stub", () =>
    Effect.gen(function*() {
      const wokenOn: Array<object> = []
      const singletonNamespace = {
        getByName: () => {
          const stub = {
            wake: () => {
              wokenOn.push(stub)
              return wokenOn.length === 1
                ? Promise.reject(retryableError("Network connection lost."))
                : Promise.resolve()
            }
          }
          return stub
        }
      }
      const cluster = yield* makeHandle(Singleton.make("lost-in-transit", Effect.void), singletonNamespace)

      yield* withTestClock(cluster.wake("lost-in-transit")())

      assert.strictEqual(wokenOn.length, 2)
      assert.notStrictEqual(wokenOn[0], wokenOn[1])
    }))

  it.effect("wakes a ClusterCron's seed singleton by its helper name", () =>
    Effect.gen(function*() {
      const resolved: Array<string> = []
      const woken: Array<string> = []
      const singletonNamespace = {
        getByName: (name: string) => {
          resolved.push(name)
          return {
            wake: () => {
              woken.push(name)
              return Promise.resolve()
            }
          }
        }
      }
      const cron = ClusterCron.make({
        name: "nightly",
        cron: Cron.parseUnsafe("0 0 * * *", "UTC"),
        execute: Effect.void
      })
      const cluster = yield* makeHandle(cron, singletonNamespace)

      yield* cluster.wake(CloudflareCluster.clusterCronSingletonName("nightly"))()

      // The ClusterCron registered its seed singleton under the same object.
      assert.include(resolved, "Singleton/ClusterCron/nightly")
      assert.deepStrictEqual(woken, ["Singleton/ClusterCron/nightly"])
    }))

  it.effect("does not retry a wake whose singleton failed, even with a retryable-looking error", () =>
    Effect.gen(function*() {
      let runs = 0
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (database) => Effect.sync(() => database.close())
      )
      const storage = new SqliteStorage(database)
      // The singleton Durable Object class awaits its program's `wake` the
      // same way.
      let program: ReturnType<typeof makeClusterSingletonProgram> extends Effect.Effect<infer P> ? Promise<P>
        : never
      const singletonNamespace = {
        getByName: (name: string) => ({
          wake: () => {
            program ??= Effect.runPromise(makeClusterSingletonProgram({
              id: { name },
              storage: storage as unknown as DurableObjectProgramState["storage"],
              exports: {},
              waitUntil: () => {}
            }))
            return program.then((program) => Effect.runPromise(program.wake()))
          }
        })
      }
      const failing = Singleton.make(
        "failing",
        Effect.suspend(() => {
          runs++
          return Effect.fail(retryableError("singleton failed"))
        })
      )
      const cluster = yield* makeHandle(failing, singletonNamespace)

      const exit = yield* withTestClock(Effect.exit(cluster.wake("failing")()))

      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(runs, 1)
    }))

  for (
    const field of [
      "entityNamespace",
      "workflowNamespace",
      "queueNamespace",
      "singletonNamespace",
      "context"
    ] as const
  ) {
    it(`diagnoses access to ${field} during plan evaluation`, () => {
      const cluster = inertClusterHandle()
      assert.throws(
        () => cluster[field],
        Error,
        `AlchemyCloudflareCluster: '${field}' is only available at runtime, not during plan evaluation`
      )
    })
  }

  it.effect("the plan-time handle is inert", () =>
    Effect.gen(function*() {
      const cluster = inertClusterHandle()
      assert.strictEqual(yield* cluster.provide(Effect.succeed("ok")), "ok")
      yield* cluster.wake("maintenance")()
    }))
})
