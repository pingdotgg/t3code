import { assert, describe, expect, it } from "@effect/vitest"
import { Array, Context, Data, Equal, Fiber, Hash } from "effect"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { flow, pipe } from "effect/Function"
import * as Request from "effect/Request"
import * as Resolver from "effect/RequestResolver"

class Counter extends Context.Service<Counter, { count: number }>()("Counter") {}
class Requests extends Context.Service<Requests, { count: number }>()("Requests") {}
class Interrupts extends Context.Reference("Interrupts", {
  defaultValue: () => ({ interrupts: 0 })
}) {}
class RequestService extends Context.Reference("RequestService", {
  defaultValue: () => ({ value: "default" })
}) {}
const delay = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.andThen(
    Effect.promise(() => new Promise((r) => setTimeout(() => r(0), 0))),
    self
  )

const userIds: ReadonlyArray<number> = Array.range(1, 26)

const userNames: ReadonlyMap<number, string> = new Map(
  Array.zipWith(
    userIds,
    Array.map(Array.range(97, 122), (a) => String.fromCharCode(a)),
    (a, b) => [a, b] as const
  )
)

type UserRequest = GetAllIds | GetNameById

interface GetAllIds extends Request.Request<ReadonlyArray<number>> {
  readonly _tag: "GetAllIds"
}
const GetAllIds = Request.tagged<GetAllIds>("GetAllIds")

interface GetRequestService extends Request.Request<string> {
  readonly _tag: "GetRequestService"
}
const GetRequestService = Request.tagged<GetRequestService>("GetRequestService")

class GetNameById extends Request.TaggedClass("GetNameById")<
  {
    readonly id: number
  },
  string,
  string
> {}

const makeUserResolver = Effect.gen(function*() {
  const counter = yield* Counter
  const requests_ = yield* Requests

  const resolver = Resolver.make<UserRequest>(Effect.fnUntraced(function*(entries) {
    counter.count++
    requests_.count += entries.length
    for (const entry of entries) {
      yield* delay(processRequest(entry))
    }
  })).pipe(Resolver.batchN(15))

  const getIds = Effect.request(GetAllIds(), resolver)
  const getNameById = (id: number) => Effect.request(new GetNameById({ id }), resolver)
  const getNameByIdPiped = (id: number) => pipe(new GetNameById({ id }), Effect.request(resolver))
  const getNames = getIds.pipe(
    Effect.flatMap(Effect.forEach(getNameById, { concurrency: "unbounded" })),
    Effect.onInterrupt(() =>
      Effect.tap(Interrupts, (i) => {
        i.interrupts++
        return Effect.void
      })
    )
  )

  return { getNames, getIds, getNameById, getNameByIdPiped } as const
})

const makeUserResolverTagged = Effect.gen(function*() {
  const counter = yield* Counter
  const requests = yield* Requests

  const resolver = Resolver.fromEffectTagged<UserRequest>()({
    GetAllIds: Effect.fnUntraced(function*(reqs) {
      counter.count++
      requests.count += reqs.length
      return reqs.map(() => userIds)
    }),
    GetNameById: Effect.fnUntraced(function*(reqs) {
      counter.count++
      requests.count += reqs.length

      const names: Array<string> = []
      for (let i = 0; i < reqs.length; i++) {
        const req = reqs[i]
        if (!userNames.has(req.request.id)) return yield* Effect.fail("Not Found")
        names.push(userNames.get(req.request.id)!)
      }
      return names
    })
  }).pipe(Resolver.batchN(15))

  const getIds = Effect.request(GetAllIds(), resolver)
  const getNameById = (id: number) => Effect.request(new GetNameById({ id }), resolver)
  const allNames = getIds.pipe(
    Effect.flatMap(Effect.forEach(getNameById, { concurrency: "unbounded" }))
  )

  return { allNames, getIds, getNameById } as const
})

const processRequest = (entry: Request.Entry<UserRequest>): Effect.Effect<void> => {
  switch (entry.request._tag) {
    case "GetAllIds": {
      return Request.complete(entry, Exit.succeed(userIds))
    }
    case "GetNameById": {
      if (userNames.has(entry.request.id)) {
        const userName = userNames.get(entry.request.id)!
        return Request.complete(entry, Exit.succeed(userName))
      }
      return Request.completeEffect(entry, Exit.fail("Not Found"))
    }
  }
}

const provideEnv = flow(
  Effect.provideServiceEffect(Counter, Effect.sync(() => ({ count: 0 }))),
  Effect.provideServiceEffect(Requests, Effect.sync(() => ({ count: 0 })))
)

describe.sequential("Request", () => {
  it("preserves __proto__ as an own constructor property", () => {
    interface ProtoRequest extends Request.Request<void> {
      readonly "__proto__": { readonly polluted: boolean }
    }
    const make = Request.of<ProtoRequest>()
    const value = { polluted: true }
    const request = make({ ["__proto__"]: value })

    assert.isTrue(Request.isRequest(request))
    assert.isTrue(Object.hasOwn(request, "__proto__"))
    assert.strictEqual(request["__proto__"], value)
  })

  it("copies enumerable symbol properties in Class", () => {
    const key = Symbol()
    class SymbolRequest extends Request.Class<{ readonly [key]: string }, void> {}

    assert.strictEqual(new SymbolRequest({ [key]: "value" })[key], "value")
  })

  it("compares StructuralProto values when hashes collide", () => {
    class Req extends Request.Class<{ id: string; account: string }, string> {}

    const a = new Req({ id: "id-8", account: "acct-2811" })
    const b = new Req({ id: "id-14", account: "acct-755" })

    assert.strictEqual(Hash.hash(a), Hash.hash(b))
    assert.strictEqual(Equal.equals(a, b), false)
  })

  it.effect(
    "requests are executed correctly",
    Effect.fnUntraced(function*() {
      const { getNames } = yield* makeUserResolver
      const names = yield* getNames
      const counter = yield* Counter
      const requests = yield* Requests
      assert.strictEqual(counter.count, 3)
      assert.strictEqual(requests.count, userIds.length + 1)
      assert.deepStrictEqual(names, userIds.map((id) => userNames.get(id)))
    }, provideEnv)
  )

  it.effect(
    "requests with dual syntax are executed correctly",
    Effect.fnUntraced(function*() {
      const names = yield* (yield* makeUserResolver).getNames
      const counter = yield* Counter
      const requests = yield* Requests
      assert.strictEqual(counter.count, 3)
      assert.strictEqual(requests.count, userIds.length + 1)
      assert.deepStrictEqual(names, userIds.map((id) => userNames.get(id)))
    }, provideEnv)
  )

  it.effect(
    "requests are executed correctly with fromEffectTagged",
    Effect.fnUntraced(function*() {
      const { allNames } = yield* makeUserResolverTagged
      const names = yield* allNames
      const count = yield* Counter
      expect(count.count).toEqual(3)
      expect(names.length).toBeGreaterThan(2)
      expect(names).toEqual(userIds.map((id) => userNames.get(id)))
    }, provideEnv)
  )

  it.effect(
    "requests don't break interruption",
    Effect.fnUntraced(
      function*() {
        const { getNames } = yield* makeUserResolver
        const fiber = yield* Effect.forkChild(getNames)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toEqual("Failure")
        if (exit._tag === "Failure") {
          expect(Cause.hasInterruptsOnly(exit.cause)).toEqual(true)
        }
        expect(yield* Counter).toEqual({ count: 0 })
        expect(yield* Interrupts).toEqual({ interrupts: 1 })
      },
      provideEnv,
      Effect.provideService(Interrupts, { interrupts: 0 })
    )
  )

  it.effect(
    "requests work with uninterruptible",
    Effect.fnUntraced(
      function*() {
        const { getNames } = yield* makeUserResolver
        const fiber = yield* Effect.forkChild(Effect.uninterruptible(getNames))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toEqual("Failure")
        if (exit._tag === "Failure") {
          expect(Cause.hasInterruptsOnly(exit.cause)).toEqual(true)
        }
        expect(yield* Counter).toEqual({ count: 3 })
        expect(yield* Interrupts).toEqual({ interrupts: 0 })
      },
      provideEnv,
      Effect.provideService(Interrupts, { interrupts: 0 })
    )
  )

  it.effect(
    "grouped requests can be interrupted before execution",
    Effect.fnUntraced(function*() {
      let resolverExecuted = false

      const resolver = Resolver.make<GetNameById>(Effect.fnUntraced(function*(entries) {
        resolverExecuted = true
        for (const entry of entries) {
          entry.completeUnsafe(Exit.succeed(userNames.get(entry.request.id)!))
        }
      })).pipe(
        Resolver.grouped(({ request }) => request.id),
        Resolver.setDelayEffect(Effect.never)
      )

      const fiber = yield* Effect.forkChild(Effect.request(new GetNameById({ id: userIds[0] }), resolver))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert.strictEqual(Cause.hasInterruptsOnly(exit.cause), true)
      }
      assert.strictEqual(resolverExecuted, false)
    })
  )

  it.effect(
    "batching preserves individual & identical requests",
    Effect.fnUntraced(function*() {
      const { getNameById } = yield* makeUserResolver
      yield* Effect.all([getNameById(userIds[0]), getNameById(userIds[0])], {
        concurrency: "unbounded",
        discard: true
      })
      const requests = yield* Requests
      const invocations = yield* Counter
      expect(requests.count).toEqual(2)
      expect(invocations.count).toEqual(1)
    }, provideEnv)
  )

  it.effect(
    "grouped requests + batchN",
    Effect.fnUntraced(function*() {
      let count = 0
      let requestsCount = 0

      class Key extends Data.Class<{ id: number }> {}

      const resolver = Resolver.make<GetNameById>(Effect.fnUntraced(function*(entries) {
        count++
        requestsCount += entries.length
        for (const entry of entries) {
          entry.completeUnsafe(Exit.succeed(userNames.get(entry.request.id)!))
        }
      })).pipe(
        Resolver.batchN(5),
        Resolver.grouped(({ request }) => new Key({ id: request.id % 2 }))
      )

      yield* Effect.forEach(userIds, (id) => Effect.request(new GetNameById({ id }), resolver), {
        concurrency: "unbounded"
      })

      expect(count).toEqual(6)
      expect(requestsCount).toEqual(26)
    })
  )

  it.effect(
    "batch fibers use request services for runAll",
    Effect.fnUntraced(function*() {
      const resolver = Resolver.make<GetRequestService>(Effect.fnUntraced(function*(entries) {
        const value = (yield* RequestService).value
        for (const entry of entries) {
          entry.completeUnsafe(Exit.succeed(value))
        }
      })).pipe(Resolver.batchN(1))

      const value = yield* Effect.request(GetRequestService(), resolver).pipe(
        Effect.provideService(RequestService, { value: "provided" })
      )

      assert.strictEqual(value, "provided")
    })
  )

  it.effect(
    "batch fibers use request services for delay effects",
    Effect.fnUntraced(function*() {
      let delayServiceValue = ""

      const resolver = Resolver.make<GetRequestService>((entries) =>
        Effect.sync(() => {
          for (const entry of entries) {
            entry.completeUnsafe(Exit.succeed("ok"))
          }
        })
      ).pipe(
        Resolver.setDelayEffect(
          Effect.andThen(
            Effect.yieldNow,
            Effect.gen(function*() {
              delayServiceValue = (yield* RequestService).value
            })
          )
        )
      )

      yield* Effect.request(GetRequestService(), resolver).pipe(
        Effect.provideService(RequestService, { value: "provided" })
      )

      assert.strictEqual(delayServiceValue, "provided")
    })
  )
})
